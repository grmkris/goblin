import { createMcpHandler } from '@modelcontextprotocol/server'
import type {
  ConversationId,
  GenerationHooks,
  Harness,
  HookApi,
  LiveState,
  Submission,
  TaskId,
} from '@earendil-works/pi-durable'
import type { FileEntry } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpHost } from '../src/mcp/connections/host.ts'
import { type LearnOutcome, logLearnOutcome, makeLearner } from '../src/skills/learner.ts'
import { skillLearningExtension } from '../src/pi/skills.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { Budget } from '../src/budget.ts'
import { ChatId } from '../src/chats/directory.ts'
import { Chats, Conversations } from '../src/chats/service.ts'
import { OWNER_VIEW } from '../src/files/folders.ts'
import { Files } from '../src/files/service.ts'
import { Resident } from '../src/mcp/service.ts'
import { type AppError, NotFound } from '../src/http/errors.ts'
import { Notices } from '../src/notices/service.ts'
import type { NewNotice } from '../src/notices/store.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import type { RunTelemetry } from '../src/telemetry/events.ts'
import { knowledgeOver } from './knowledge-layer.ts'
import { makeSkills } from '../src/skills/library.ts'
import { Learner } from '../src/skills/service.ts'
import { SKILLS_EXTENSION } from '../src/skills/protocol.ts'
import { MemoryCredentials, MemoryGrants, MemoryLabels, MemoryRegistries } from './mcp/memory.ts'
import { MemoryDraftLog, MemorySkillState } from './skills-memory.ts'
import { lowLevelServer } from './mcp/low-level-server.ts'
import { servicesOf } from './mcp/runtime.ts'
import { fake, unread } from './fake.ts'
import { BACKGROUND, entryId, submissionId } from '../src/pi/context.ts'
import { admitReceipt } from '../src/chats/receipts.ts'
import { senderPower } from '../src/grants/power.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'
import type { CheapModel } from '../src/memory/model.ts'

/** The owner's files the learner wrote, by path, and the notices it claimed, in order. */
const owner: { files: Map<string, string>; notices: NewNotice[] } = { files: new Map(), notices: [] }
const ownerFiles = Layer.mock(Files)({
  stat: (_view, path: string) =>
    owner.files.has(path) ? Effect.succeed(fake<FileEntry>({ path })) : Effect.fail(new NotFound({ what: 'file' })),
  write: (view, path: string, body) =>
    Effect.sync(() => {
      // A draft is goblin's own keeping, in the Shared folder (ADR 0115).
      expect(view).toBe(OWNER_VIEW)
      // SAFETY: the learner writes its drafts as text.
      owner.files.set(path, body as string)
      return fake<FileEntry>({ path })
    }),
})
const ownerNotices = Layer.mock(Notices)({
  claim: (notice: NewNotice) =>
    Effect.sync(() => {
      owner.notices.push(notice)
      return { posted: true }
    }),
  // The notice's entry is written by the routines' notices, which this test does not run.
  get: () => Effect.succeed(undefined),
})
const AnyParams = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const skills = createMcpHandler(() => {
  const server = lowLevelServer(
    { name: 'library', version: '1.0.0' },
    { capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
  )
  server.setRequestHandler('skills/list', { params: AnyParams }, () => ({ skills: [], ttlMs: 60_000 }))
  server.setRequestHandler('resources/list', () => ({ resources: [] }))
  return server
})

/** The latest exchange of the conversation, as Pi entries newest first. */
let exchange: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[] = []
const piConversation = {
  entries: async () => ({
    items: exchange
      .map((message, at) => ({
        id: at,
        kind: message.role === 'user' ? 'pi.user' : 'pi.assistant',
        model: [{ role: message.role, content: [{ type: 'text', text: message.text }] }],
      }))
      .toReversed(),
    next: undefined,
  }),
}
/** The cheap model's answer, and how many times it was asked. */
const model = { answer: '{"action":"none"}', calls: 0 }

const state = new MemorySkillState()
const credentials = new MemoryCredentials()
await credentials.saveTokens('lib', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
let drafts = new MemoryDraftLog()
/**
 * The learner over an MCP host for the library server it takes skills from, the owner's files and notices, and a chat
 * for the conversation, on a test clock at 10,000,000 ms.
 */
const learnerAt = () => {
  const host = mcpHost({
    servers: [{ connectionId: 'lib', endpoint: 'https://library.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    skillsEnabled: (connectionId) => state.enabled(connectionId),
    appUrl: 'https://goblin.test',
    workspaceId: 'workspace',
    fetch: async (input, init) => skills.fetch(new Request(input, init)),
  })
  const services = servicesOf(
    Layer.effect(
      Learner,
      Effect.gen(function* () {
        const skillsService = yield* makeSkills(state)
        return yield* makeLearner({
          drafts,
          state,
          skills: skillsService,
          // The learner only calls `complete`, which this fixture answers.
          model: fake<CheapModel>({
            complete: async () => {
              model.calls += 1
              return model.answer
            },
          }),
        })
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          host.pipe(Layer.provide(SingleFlight.layer)),
          ownerFiles,
          ownerNotices,
          Layer.mock(Chats)({ primary: ChatId('1'), chatOf: () => Effect.succeed(Option.some(ChatId('7'))) }),
          Layer.mock(Conversations)({}),
          Layer.succeed(Changes, makeChanges()),
          Layer.mock(PiSessions)({
            // SAFETY: the learner only reads `entries()` of the conversation, which this fixture answers.
            conversation: () => Effect.succeed(Option.some(piConversation as never)),
          }),
          SingleFlight.layer,
          TestClock.layer(),
        ),
      ),
    ),
  )
  let learner: Promise<Learner['Service']> | undefined
  const started = () => (learner ??= services.run(Effect.andThen(TestClock.setTime(10_000_000), Learner)))
  return { ...services, learner: started }
}
let services: ReturnType<typeof learnerAt>
const consider = async (id: ConversationId) => services.run((await services.learner()).consider(id))
const later = (ms: number) => services.run(TestClock.adjust(ms))
// SAFETY: Pi conversation ids are numbers; the fixture harness ignores which one is asked for.
const MAIN = 0 as ConversationId

const NEW_SKILL = JSON.stringify({
  action: 'new',
  name: 'weekly-review',
  description: 'Review the week: blocked tasks first, then decisions that changed.',
  body: '1. List blocked tasks first.\n2. Then decisions that changed since last week.\nAsk ana@example.com if unsure.',
  evidence: 'The owner said the review must start with blocked tasks.',
})

const failedRun: RunProgram = async () => {
  throw new Error('private transcript and secret-shaped content must stay out of outcome logs')
}

const hasYieldHook = (handlers: object | undefined): handlers is Pick<GenerationHooks, 'onYield'> =>
  handlers !== undefined && 'onYield' in handlers && typeof handlers.onYield === 'function'

beforeEach(() => {
  owner.files = new Map()
  owner.notices = []
  model.calls = 0
  model.answer = '{"action":"none"}'
  drafts = new MemoryDraftLog()
  state.setEnabled('lib', true)
  exchange = [
    { role: 'user', text: 'Do the weekly review.' },
    { role: 'assistant', text: 'Here is the review: decisions first.' },
    { role: 'user', text: 'No, next time always start with the blocked tasks.' },
    { role: 'assistant', text: 'Understood, blocked tasks first.' },
  ]
  services = learnerAt()
})
afterEach(async () => {
  await services.dispose()
})

describe('the skill learner (unit)', () => {
  it("never drafts from a turn a server's key sent, and never asks the model for it (ADR 0115)", async () => {
    model.answer = NEW_SKILL
    const { db, close } = chatDatabase()
    const power = senderPower({
      kind: 'key',
      grant: { grantId: 'key-1', level: 'manage', extras: [], topics: 'all', connections: 'all' },
    })
    admitReceipt(db, {
      chat: '1',
      operationId: 'op-key',
      receipt: { kind: 'send', origin: 'key', power },
      session: () => '1',
      now: 1,
    })
    const harness = fake<Harness>({
      submission: async (id) =>
        fake<Submission>({
          status: async () => ({
            id,
            conversationId: MAIN,
            type: 'input',
            status: 'placed',
            entry: entryId(1),
            requestId: 'op-key',
          }),
        }),
    })
    const layer = Layer.mergeAll(
      sqliteDb(db),
      Layer.succeed(PiSessions, fake<PiSessions['Service']>({ pi: Effect.succeed(harness) })),
      // The run recorder saw the key's message admitted, so its request id is known without asking Pi.
      Layer.succeed(AgentInput, fake<AgentInputs>({ telemetry: fake<RunTelemetry>({ requestOf: () => 'op-key' }) })),
    )
    const run: RunProgram = <A>(program: Parameters<RunProgram>[0]) =>
      // SAFETY: the hook reads only the run's power before it skips, over this test's layer.
      Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
    const outcomes: LearnOutcome[] = []
    const hooks = skillLearningExtension(run, (_conversation, outcome) => outcomes.push(outcome)).hooks?.[0]?.handlers
    if (!hasYieldHook(hooks)) throw new Error('skills onYield hook missing')
    // SAFETY: Pi's task ids are plain integers at runtime; the brand only types them.
    const live: LiveState = { run: { taskId: 9 as TaskId, inputs: [submissionId(1)] } }
    // SAFETY: the hook reads one document through `snapshot`, the conversation's LiveDoc, which is `live`.
    const api = fake<HookApi>({ conversationId: MAIN, snapshot: async <T>() => live as T })
    expect(await hooks.onYield(unread, api, BACKGROUND)).toBeUndefined()
    expect(outcomes).toEqual(['skipped'])
    expect(model.calls).toBe(0)
    expect(owner.files.size).toBe(0)
    close()
  })

  it('observes malformed model replies as failed without exposing the reply or holding up the answer', async () => {
    model.answer = 'private malformed model reply, with no decision JSON'
    const outcomes: LearnOutcome[] = []
    const layer = Layer.mergeAll(
      knowledgeOver({ learner: await services.learner() }),
      Layer.mock(Resident)({ require: () => Effect.void }),
      Layer.mock(Budget)({ require: () => Effect.void }),
    )
    const run: RunProgram = <A>(program: Parameters<RunProgram>[0]) =>
      // SAFETY: onYield uses only Learner, Resident and Budget, provided by this test's layer.
      Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
    const extension = skillLearningExtension(run, (_conversation, outcome) => outcomes.push(outcome))
    const hooks = extension.hooks?.[0]?.handlers
    if (!hasYieldHook(hooks)) throw new Error('skills onYield hook missing')
    // The hook reads only the conversation and its live run (none: the agent's own); the answer is never read.
    const api = fake<HookApi>({ conversationId: MAIN, snapshot: async () => undefined })
    expect(await hooks.onYield(unread, api, BACKGROUND)).toBeUndefined()
    await vi.waitFor(() => expect(outcomes).toEqual(['failed']))
    expect(model.calls).toBe(1)
  })

  it('reports a failed background hook without leaking error content or blocking the final answer', async () => {
    const outcomes: { conversation: ConversationId; outcome: LearnOutcome }[] = []
    const extension = skillLearningExtension(failedRun, (conversation, outcome) =>
      outcomes.push({ conversation, outcome }),
    )
    const hooks = extension.hooks?.[0]?.handlers
    if (!hasYieldHook(hooks)) throw new Error('skills onYield hook missing')
    // The hook reads only the conversation and its live run; the answer is never read.
    const api = fake<HookApi>({ conversationId: MAIN, snapshot: async () => undefined })
    expect(await hooks.onYield(unread, api, BACKGROUND)).toBeUndefined()
    await vi.waitFor(() => expect(outcomes).toEqual([{ conversation: MAIN, outcome: 'failed' }]))
    expect(JSON.stringify(outcomes)).not.toContain('private')
  })

  it('logs an outcome as one line through the logger: the conversation and the outcome, nothing else', () => {
    const lines: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(line))
    try {
      logLearnOutcome(MAIN, 'drafted')
    } finally {
      spy.mockRestore()
    }
    expect(lines.map((line) => JSON.parse(String(line)))).toEqual([
      { level: 'info', event: 'skill-learner', conversation: '0', kind: 'drafted' },
    ])
  })

  it('asks the model nothing when the owner neither corrected nor asked to keep anything', async () => {
    exchange = [
      { role: 'user', text: 'Thanks, that is great.' },
      { role: 'assistant', text: 'Glad it helped.' },
    ]
    expect(await consider(MAIN)).toBe('skipped')
    expect(model.calls).toBe(0)
  })

  it('drafts nothing when the model finds no procedure', async () => {
    expect(await consider(MAIN)).toBe('none')
    expect(model.calls).toBe(1)
    expect([...owner.files.keys()]).toEqual([])
    expect(owner.notices).toEqual([])
  })

  it("writes a new skill's draft to the owner's files without private details, tells them, and never twice", async () => {
    model.answer = `Sure. ${NEW_SKILL}`
    expect(await consider(MAIN)).toBe('drafted')
    expect([...owner.files.keys()]).toEqual(['/agent/skills/drafts/weekly-review.md'])
    const text = owner.files.get('/agent/skills/drafts/weekly-review.md') ?? ''
    expect(text).toMatch(/^---\nname: weekly-review\ndescription: "Review the week/u)
    expect(text).toContain('List blocked tasks first.')
    expect(text).not.toContain('ana@example.com')
    // The owner is told in the chat the lesson came from, with where the draft is and what taught it.
    expect(owner.notices).toEqual([
      expect.objectContaining({
        chatId: '7',
        connectionId: null,
        title: 'Drafted a new skill, "weekly-review", for you to review: /agent/skills/drafts/weekly-review.md',
        body: 'The owner said the review must start with blocked tasks.',
      }),
    ])
    expect(owner.notices[0]?.id).toMatch(/^notice:skill-draft:[0-9a-f]{32}$/u)
    // The same lesson again, while the first draft waits in the owner's files: no second draft.
    expect(await consider(MAIN)).toBe('duplicate')
    expect(owner.notices).toHaveLength(1)
  })

  it("does not write over a draft still in the owner's files, and drafts the skill again once they moved it", async () => {
    model.answer = NEW_SKILL
    expect(await consider(MAIN)).toBe('drafted')
    model.answer = NEW_SKILL.replace('List blocked tasks first.', 'List the blocked tasks first of all.')
    expect(await consider(MAIN)).toBe('duplicate')
    owner.files.clear()
    expect(await consider(MAIN)).toBe('drafted')
    expect(owner.files.get('/agent/skills/drafts/weekly-review.md')).toContain('List the blocked tasks first of all.')
    // The same draft as the first is still never written again.
    owner.files.clear()
    model.answer = NEW_SKILL
    expect(await consider(MAIN)).toBe('duplicate')
  })

  it('stays quiet, without asking the model, while skills are off for every server', async () => {
    model.answer = NEW_SKILL
    state.setEnabled('lib', false)
    expect(await consider(MAIN)).toBe('skipped')
    expect(model.calls).toBe(0)
    expect([...owner.files.keys()]).toEqual([])
  })

  it('writes at most five drafts a day', async () => {
    for (let n = 0; n < 5; n++) {
      model.answer = NEW_SKILL.replace('weekly-review', `review-${n}`)
      expect(await consider(MAIN)).toBe('drafted')
    }
    model.answer = NEW_SKILL.replace('weekly-review', 'review-5')
    expect(await consider(MAIN)).toBe('skipped')
    await later(86_400_001)
    expect(await consider(MAIN)).toBe('drafted')
  })
})
