// The cases the AG-UI golden tests cover, run on a real Pi Harness (pi-durable's MemoryStorage, in this process) with
// a scripted model that streams its answers block by block, each conversation's committed batches recorded with Pi's
// own `watchEvents`. `record.ts` writes them to `fixtures/` (the goldens' input); `live.test.ts` runs them against the
// installed Pi on every test run. No network and no model spend.
import type { AssistantMessage, Message, ProviderStreams, Usage } from '@earendil-works/pi-ai'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import {
  type AgentEvent,
  type Conversation,
  type EntryDraft,
  Harness,
  MemoryStorage,
  type SnapshotEvent,
  createRegistry,
  defineExtension,
  watchEvents,
} from '@earendil-works/pi-durable'
import { type JsonObject, authorTag, memberAuthor } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { askUserExtension } from '../../src/pi/ask-user.ts'
import { BACKGROUND } from '../../src/pi/context.ts'
import { typedTool } from '../../src/pi/typed-tool.ts'
import { model } from '../integration/model.ts'

/**
 * One recorded conversation: every batch its watch saw from the start, a snapshot taken mid-answer (`after` the
 * batches delivered by then) where the scenario takes one, and the snapshot of the conversation once it was idle.
 */
export type Recording = {
  readonly chat: string
  readonly batches: readonly (readonly AgentEvent[])[]
  readonly mid?: { readonly after: number; readonly snapshot: SnapshotEvent }
  readonly final: SnapshotEvent
}

/** A part of a scripted answer: text or thinking in chunks, or a tool call whose arguments grow step by step. */
type Part =
  | { readonly text: readonly string[] }
  | { readonly thinking: readonly string[] }
  | { readonly call: { readonly id: string; readonly name: string; readonly steps: readonly JsonObject[] } }

/** One scripted answer: its parts, or a failure; `pause` holds it after that many chunks until released. */
type Reply = { readonly parts?: readonly Part[]; readonly error?: string; readonly pause?: number }

const USAGE: Usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const ZERO: Usage = { ...USAGE, input: 0, output: 0, cacheRead: 0, totalTokens: 0 }

const tick = (ms = 12) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A deterministic clock: Pi's `now` and every message's timestamp, one millisecond per read. */
const clock = () => {
  let at = 1_760_000_000_000
  return () => (at += 1)
}

/** The scripted model: answers in order, streamed with a pause between chunks so Pi commits partials as it goes. */
class ScriptedModel {
  readonly #replies: Reply[]
  readonly #now: () => number
  #release: (() => void) | undefined
  readonly paused: PromiseWithResolvers<void> = Promise.withResolvers<void>()
  constructor(replies: readonly Reply[], now: () => number) {
    this.#replies = [...replies]
    this.#now = now
  }
  release(): void {
    this.#release?.()
  }
  readonly streams: ProviderStreams = {
    stream: (target, _context, options) => {
      const reply = this.#replies.shift() ?? { parts: [{ text: ['done'] }] }
      const message: AssistantMessage = {
        role: 'assistant',
        api: target.api,
        provider: target.provider,
        model: target.id,
        content: [],
        usage: ZERO,
        stopReason: 'stop',
        timestamp: this.#now(),
      }
      const output = createAssistantMessageEventStream()
      const aborted = new Promise<'aborted'>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true }),
      )
      this.#play(reply, message, output, aborted).catch((error: unknown) => {
        // expected: a script that throws ends its answer as a failed model call, which the scenario then shows
        const failed = { ...message, stopReason: 'error' as const, errorMessage: String(error) }
        output.push({ type: 'error', reason: 'error', error: failed })
        output.end(failed)
      })
      return output
    },
    streamSimple: (target, context, options) => this.streams.stream(target, context, options),
  }

  /** Waits `chunks` into the answer when it pauses there; true when the request was aborted meanwhile. */
  async #step(reply: Reply, chunks: number, aborted: Promise<'aborted'>): Promise<boolean> {
    await tick()
    if (reply.pause !== chunks) return false
    const gate = Promise.withResolvers<'released'>()
    this.#release = () => gate.resolve('released')
    this.paused.resolve()
    return (await Promise.race([gate.promise, aborted])) === 'aborted'
  }

  async #play(
    reply: Reply,
    message: AssistantMessage,
    output: ReturnType<typeof createAssistantMessageEventStream>,
    aborted: Promise<'aborted'>,
  ): Promise<void> {
    output.push({ type: 'start', partial: message })
    let chunks = 0
    for (const part of reply.parts ?? []) {
      const index = message.content.length
      for (const chunk of chunksOf(part)) {
        grow(message, index, part, chunk, output)
        chunks += 1
        if (await this.#step(reply, chunks, aborted)) {
          const stopped = { ...message, stopReason: 'aborted' as const, errorMessage: 'Request was aborted' }
          output.push({ type: 'error', reason: 'aborted', error: stopped })
          return output.end(stopped)
        }
      }
    }
    if (reply.error !== undefined) {
      const failed = { ...message, stopReason: 'error' as const, errorMessage: reply.error }
      output.push({ type: 'error', reason: 'error', error: failed })
      return output.end(failed)
    }
    const calls = message.content.some((block) => block.type === 'toolCall')
    const final = { ...message, usage: USAGE, stopReason: calls ? ('toolUse' as const) : ('stop' as const) }
    output.push({ type: 'done', reason: final.stopReason, message: final })
    output.end(final)
  }
}

/** A part's chunks: its text pieces, or a call's argument steps by index. */
const chunksOf = (part: Part): readonly (string | number)[] =>
  'text' in part ? part.text : 'thinking' in part ? part.thinking : part.call.steps.map((_step, index) => index)

/** The partial grows by one chunk of `part` at `index`, and the provider says so. */
function grow(
  message: AssistantMessage,
  index: number,
  part: Part,
  chunk: string | number,
  output: ReturnType<typeof createAssistantMessageEventStream>,
): void {
  const partial = message
  if ('call' in part) {
    const args = part.call.steps[Number(chunk)] ?? {}
    if (partial.content[index] === undefined) {
      partial.content.push({ type: 'toolCall', id: part.call.id, name: part.call.name, arguments: args })
      output.push({ type: 'toolcall_start', contentIndex: index, partial })
    } else partial.content[index] = { type: 'toolCall', id: part.call.id, name: part.call.name, arguments: args }
    output.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(args), partial })
    return
  }
  const delta = String(chunk)
  const block = partial.content[index]
  if ('text' in part) {
    if (block?.type !== 'text') partial.content.push({ type: 'text', text: delta })
    else block.text += delta
    output.push({ type: 'text_delta', contentIndex: index, delta, partial })
    return
  }
  if (block?.type !== 'thinking') partial.content.push({ type: 'thinking', thinking: delta })
  else block.thinking += delta
  output.push({ type: 'thinking_delta', contentIndex: index, delta, partial })
}

/** A tool that reports progress as it runs: two pieces of output and its details, then the forecast. */
const forecast = typedTool({
  name: 'forecast',
  description: 'The forecast for a city.',
  input: Schema.Struct({ city: Schema.String }),
  output: Schema.Struct({ city: Schema.String, sky: Schema.String }),
  replay: 'safe',
  execute: async ({ city }, api, context) => {
    api.output('Looking up ')
    await tick(30)
    await api.details({ kind: 'forecast', step: 1 }, context)
    api.output(city)
    await tick(30)
    return { city, sky: 'sunny' }
  },
  text: ({ city, sky }) => `${city}: ${sky}`,
  details: () => ({ kind: 'forecast' }),
})
const tools = defineExtension({ name: 'streams.fixture', tools: [forecast] })

/** What a scenario does with the root conversation, the model and the clock. */
type Driver = { readonly root: Conversation; readonly model: ScriptedModel; readonly now: () => number }

/** A passive write into the root conversation, with one user model message. */
async function write(driver: Driver, entry: Omit<EntryDraft, 'model'>, text: string, requestId: string): Promise<void> {
  const said = [{ role: 'user' as const, content: text, timestamp: driver.now() }] satisfies Message[]
  const submitted = await driver.root.submit({ type: 'write', entry: { ...entry, model: said }, requestId }, BACKGROUND)
  await submitted.wait(BACKGROUND)
}

/** The owner's input, waited for. */
async function input(driver: Driver, content: string | { type: 'text'; text: string }[], requestId: string) {
  const submitted = await driver.root.submit({ type: 'input', content, requestId }, BACKGROUND)
  await submitted.wait(BACKGROUND)
}

const PERSONA = { persona: 4, name: 'Squarewave', revision: 2, avatar: { glyph: 'S', hue: 210 } }
const QUESTIONS = [
  {
    id: 'size',
    prompt: 'Which size?',
    kind: 'single',
    options: [
      { id: 'square', label: 'Square' },
      { id: 'tall', label: 'Tall' },
    ],
  },
]

/** A scenario: the model's answers, and what happens in the conversation. */
type Scenario = {
  readonly replies: readonly Reply[]
  readonly run: (driver: Driver, snapshotMid: () => Promise<void>) => Promise<void>
}

export const scenarios = {
  plain: {
    replies: [{ parts: [{ text: ['Hello', ' there,', ' friend.'] }] }],
    run: (driver) => input(driver, 'hello', 'op-plain'),
  },
  reasoning: {
    replies: [{ parts: [{ thinking: ['Two and', ' two.'] }, { text: ['It is', ' four.'] }] }],
    run: (driver) => input(driver, 'what is 2+2?', 'op-reasoning'),
  },
  tool: {
    replies: [
      {
        parts: [
          { text: ['Checking.'] },
          { call: { id: 'call-1', name: 'forecast', steps: [{}, { city: 'Tal' }, { city: 'Tallinn' }] } },
        ],
      },
      { parts: [{ text: ['It is', ' sunny.'] }] },
    ],
    run: (driver) => input(driver, 'weather in Tallinn?', 'op-tool'),
  },
  attachments: {
    replies: [{ parts: [{ text: ['Got it.'] }] }],
    run: (driver) =>
      input(
        driver,
        [
          { type: 'text', text: authorTag(memberAuthor('Ada', 'user-1')) },
          { type: 'text', text: 'Here is the plan' },
          {
            type: 'text',
            text: JSON.stringify({
              attachments: [{ path: '/uploads/plan.pdf', name: 'plan.pdf', size: 1024, mimeType: 'application/pdf' }],
            }),
          },
        ],
        'op-attachments',
      ),
  },
  question: {
    replies: [{ parts: [{ call: { id: 'call-q', name: 'ask_user', steps: [{ questions: QUESTIONS }] } }] }],
    run: (driver) => input(driver, 'make me a poster', 'op-question'),
  },
  aborted: {
    replies: [{ parts: [{ text: ['Starting', ' a long', ' answer'] }], pause: 1 }],
    run: async (driver) => {
      const submitted = await driver.root.submit(
        { type: 'input', content: 'write a book', requestId: 'op-abort' },
        BACKGROUND,
      )
      await driver.model.paused.promise
      await tick(60)
      await driver.root.abort(BACKGROUND)
      await submitted.wait(BACKGROUND)
    },
  },
  error: {
    replies: [{ error: '503 Service Unavailable: overloaded' }, { error: '503 Service Unavailable: overloaded' }],
    run: (driver) => input(driver, 'are you there?', 'op-error'),
  },
  persona: {
    replies: [],
    run: async (driver) => {
      const ask = { personas: [{ id: 4, name: 'Squarewave', revision: 2 }], order: 'parallel' }
      await write(driver, { kind: 'app.persona_ask', data: ask }, '[to @Squarewave] plan the launch', 'ask-1')
      const answer = { ...PERSONA, operationId: 'op-persona', text: 'Here is the plan.' }
      await write(driver, { kind: 'app.persona', data: answer }, 'Here is the plan.', 'persona-1')
      const hold = { kind: 'grant', connectionId: 'calendar', name: 'events_list', fork: '12' }
      const held = { ...PERSONA, operationId: 'op-persona-2', text: 'I need the calendar first.', hold }
      await write(driver, { kind: 'app.persona', data: held }, 'I need the calendar first.', 'persona-2')
    },
  },
  activities: {
    replies: [],
    run: async (driver) => {
      const head = { thread: '7', text: 'Plan the trip', operationId: 'op-head' }
      await write(driver, { kind: 'app.thread_head', data: head }, 'Plan the trip', 'thread-head:op-head')
      const notice = {
        notice: 'n-1',
        routine: 'r-1',
        source: 'reminder',
        from: { label: 'Daily check' },
        title: 'Water the plants',
      }
      await write(driver, { kind: 'app.notice', data: notice }, 'Water the plants', 'notice-1')
      const result = { delegate: '9', name: 'Researcher', status: 'done', text: 'Found three flights.' }
      await write(driver, { kind: 'app.delegate_result', data: result }, 'Found three flights.', 'delegate-1')
      await write(driver, { kind: 'app.shared', data: { thread: '7' } }, 'Shared from the thread', 'share-1')
    },
  },
  overflow: {
    replies: [{ parts: [{ text: ['One', ' two', ' three', ' four'] }], pause: 2 }],
    run: async (driver, snapshotMid) => {
      const submitted = await driver.root.submit({ type: 'input', content: 'count', requestId: 'op-count' }, BACKGROUND)
      await driver.model.paused.promise
      await tick(80)
      await snapshotMid()
      driver.model.release()
      await submitted.wait(BACKGROUND)
    },
  },
  queue: {
    replies: [{ parts: [{ text: ['First', ' answer.'] }], pause: 1 }, { parts: [{ text: ['Second answer.'] }] }],
    run: async (driver) => {
      const first = await driver.root.submit({ type: 'input', content: 'first', requestId: 'op-first' }, BACKGROUND)
      await driver.model.paused.promise
      const second = await driver.root.submit(
        { type: 'input', content: 'second', requestId: 'op-second', whenBusy: 'followUp' },
        BACKGROUND,
      )
      await tick(60)
      driver.model.release()
      await first.wait(BACKGROUND)
      await second.wait(BACKGROUND)
    },
  },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarios

/** Runs one scenario on a fresh Harness and returns what its root conversation's watch saw. */
export async function record(name: ScenarioName): Promise<Recording> {
  const scenario: Scenario = scenarios[name]
  const now = clock()
  const scripted = new ScriptedModel(scenario.replies, now)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: scripted.streams,
    }),
  )
  const registry = createRegistry()
  registry.install(askUserExtension)
  registry.install(tools)
  const settings = {
    extensions: [askUserExtension, tools],
    progress: { partialIntervalMs: 5, outputIntervalMs: 5 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 },
  }
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings, now }, BACKGROUND)
  try {
    const root = await harness.root(BACKGROUND, {
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
    })
    const watch = await watchEvents(harness, root.id, BACKGROUND)
    const batches: AgentEvent[][] = []
    watch.start(async (events) => {
      batches.push(JSON.parse(JSON.stringify(events)))
    })
    const snapshotNow = async (): Promise<SnapshotEvent> => {
      const second = await watchEvents(harness, root.id, BACKGROUND)
      await second.stop()
      return JSON.parse(JSON.stringify(second.snapshot))
    }
    let mid: Recording['mid']
    await scenario.run({ root, model: scripted, now }, async () => {
      mid = { after: batches.length, snapshot: await snapshotNow() }
    })
    await root.waitForIdle(BACKGROUND)
    await tick(80)
    await watch.stop()
    return { chat: '1', batches, ...(mid === undefined ? {} : { mid }), final: await snapshotNow() }
  } finally {
    await harness.close(BACKGROUND)
  }
}
