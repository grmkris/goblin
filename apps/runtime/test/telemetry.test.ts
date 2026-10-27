import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage, Message, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { createRegistry, defineExtension, defineTool, hook, Harness, ToolTask } from '@earendil-works/pi-durable'
import type { CommitPublication, Extension, JsonObject } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import { BACKGROUND } from '../src/pi/context.ts'
import { RunTelemetry, boundAttributes, type RunSink, type RunStamp } from '../src/telemetry/events.ts'
import { RunLog } from '../src/telemetry/log.ts'
import { PiRunRecorder, sourceOf } from '../src/telemetry/pi.ts'
import { ranWith } from '../src/telemetry/ran-with.ts'
import { auxReporter, mcpReporter } from '../src/telemetry/report.ts'
import { CheapModel } from '../src/memory/model.ts'
import { MODEL_PROVIDER } from '../src/pi/model.ts'
import { type StepReport, reaching, timed } from '../src/mcp/connections/log.ts'
import type { McpStep } from '../src/telemetry/report.ts'
import { grantRequiredResult } from '../src/mcp/connections/extension.ts'
import { NeedsAuthorization, NotFound, UpstreamMcp } from '../src/http/errors.ts'
import { CollectedRuns } from './telemetry-sink.ts'

const model: Model<'openai-completions'> = {
  id: 'telemetry-fixture',
  name: 'Telemetry fixture',
  provider: 'fixture',
  api: 'openai-completions',
  baseUrl: 'https://no-model-calls.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

type Reply = Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>

/** A scripted model: each request takes the next reply; after a tool result it answers `done`. */
function scripted(replies: Reply[]): ProviderStreams {
  const stream: ProviderStreams['stream'] = (target, context) => {
    const last = context.messages.findLast((message: Message) => message.role !== 'system')
    const reply: Reply =
      last?.role === 'toolResult'
        ? { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }
        : (replies.shift() ?? { content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' })
    const message: AssistantMessage = {
      role: 'assistant',
      api: target.api,
      provider: target.provider,
      model: target.id,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
      ...reply,
    }
    const output = createAssistantMessageEventStream()
    queueMicrotask(() => {
      output.push({ type: 'start', partial: message })
      if (message.stopReason === 'error') output.push({ type: 'error', reason: 'error', error: message })
      else output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
      output.end(message)
    })
    return output
  }
  return { stream, streamSimple: stream }
}

/** Models whose one provider is `scripted(replies)`, for a cheap model call outside Pi. */
const cheapModels = (replies: Reply[]) => {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: MODEL_PROVIDER,
      models: [{ ...model, provider: MODEL_PROVIDER }],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: scripted(replies),
    }),
  )
  return models
}

const call = (name: string, args: JsonObject): Reply => ({
  content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
  stopReason: 'toolUse',
})

const tools = defineExtension({
  name: 'telemetry-tools',
  tools: [
    defineTool({
      name: 'echo',
      description: 'echo',
      parameters: Type.Object({ text: Type.String() }),
      replay: 'safe',
      execute: async ({ text }) => ({ output: [{ type: 'text', text }] }),
    }),
    defineTool({
      name: 'mcp_call',
      description: 'stand-in for the resident MCP tool',
      parameters: Type.Object({ connectionId: Type.String(), name: Type.String(), arguments: Type.Object({}) }),
      replay: 'unsafe',
      execute: async () => ({ output: [{ type: 'text', text: 'remote said no' }], isError: true }),
    }),
    defineTool({
      name: 'wait_grant',
      description: 'owner decision',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => grantRequiredResult('myplan', 'notes_search', 'myplan'),
    }),
    defineTool({
      name: 'guarded',
      description: 'always blocked',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => ({ output: [{ type: 'text', text: 'never runs' }] }),
    }),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (toolCall) => (toolCall.name === 'guarded' ? { block: 'budget used up' } : undefined),
    }),
  ],
})

/** The newest state of every event, from a sink that also answers the recorder's ledger questions. */
class Collected extends CollectedRuns {
  latestForTask(kind: string, taskId: string) {
    return this.events().findLast((event) => event.kind === kind && event.taskId === taskId)
  }
  read(id: string) {
    return this.events().find((event) => event.id === id)
  }
}

/** One turn through real Pi (in memory) with the recorder attached; returns the run events it recorded. */
async function turn(
  replies: Reply[],
  input = 'hello',
  operationId = 'op-1',
  extra: readonly RunSink[] = [],
  stamp?: RunStamp,
) {
  const collected = new Collected()
  const telemetry = new RunTelemetry([...extra, collected], (id) => collected.read(id), stamp)
  const { pi, root } = await openPi(replies, new PiRunRecorder(telemetry, collected))
  const settled = await (
    await root.submit({ type: 'input', content: input, requestId: operationId }, BACKGROUND)
  ).wait(BACKGROUND)
  await pi.close(BACKGROUND)
  return { settled, events: collected.events() }
}

/** Real Pi in memory, answering with `replies`, its root on `tools` (and able to add `more`), with `recorder` on. */
async function openPi(replies: Reply[], recorder: PiRunRecorder, more: readonly Extension[] = []) {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: scripted(replies),
    }),
  )
  const registry = createRegistry()
  for (const extension of [tools, ...more]) registry.install(extension)
  const pi = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [tools], retry: { baseDelayMs: 1 } } },
    BACKGROUND,
  )
  recorder.attach(pi)
  const root = await pi.root(BACKGROUND, {
    agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
  })
  return { pi, root }
}

/** Two turns in one conversation, the second after `added` joins its extensions; the run events they recorded. */
async function twoTurns(added: Extension) {
  const collected = new Collected()
  const { pi, root } = await openPi(
    [],
    new PiRunRecorder(new RunTelemetry([collected], (id) => collected.read(id)), collected),
    [added],
  )
  await (await root.submit({ type: 'input', content: 'one', requestId: 'op-1' }, BACKGROUND)).wait(BACKGROUND)
  await root.configure({ extensions: [tools, added] }, BACKGROUND)
  await (await root.submit({ type: 'input', content: 'two', requestId: 'op-2' }, BACKGROUND)).wait(BACKGROUND)
  await pi.close(BACKGROUND)
  return collected.events()
}

/** One commit as Pi publishes it, made by hand. */
const commit = (seq: number, changes: readonly unknown[]): CommitPublication =>
  // SAFETY: a hand-made publication of entry and task records; the recorder decodes every record it reads.
  ({ seq, changes }) as CommitPublication

/** `count` comma-separated names of `length` characters each, numbered so each differs. */
const nameList = (count: number, length: number) =>
  Array.from({ length: count }, (_, index) => `${String(index).padStart(2, '0')}${'n'.repeat(length - 2)}`).join(',')

const ofKind = (events: readonly RunEvent[], kind: RunEvent['kind']) => events.filter((event) => event.kind === kind)
/** A Persona turn's task record `id` in conversation 3, in `state`. */
const personaTurn = (id: number, state: object) => ({
  type: 'task',
  value: { id, conversationId: 3, kind: 'goblin.persona-turn', input: {}, state },
})
/** `work` as one remote MCP step, reported to `report` when it ends; its value, or its own rejection. */
const step = <A>(mcpStep: McpStep, work: () => Promise<A>, report: StepReport) =>
  Effect.runPromise(Effect.promise(work).pipe(timed(mcpStep, report)))

const throwingReport = () => {
  throw new Error('PRIVATE_CALLBACK_ERROR')
}

describe('run telemetry from Pi commits (unit, in-memory Pi)', () => {
  it('keeps invalid tool arguments and provider error payloads out of telemetry', async () => {
    const privateText = 'PRIVATE_APP_SOURCE_7fd8'
    const provider = await turn([
      { content: [], stopReason: 'error', errorMessage: `provider rejected ${privateText}` },
    ])
    expect(JSON.stringify(provider.events)).not.toContain(privateText)
    expect(ofKind(provider.events, 'model.attempt')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.error]: 'Model provider failed.' } },
    ])
    const { events } = await turn([call('echo', { source: privateText })])
    expect(JSON.stringify(events)).not.toContain(privateText)
    expect(ofKind(events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'invalid_arguments' } },
    ])
  })
  it('records a turn: a failed attempt that is retried, a tool round, the answer', async () => {
    const { settled, events } = await turn([
      { content: [], stopReason: 'error', errorMessage: 'HTTP 503 upstream overloaded' },
      call('echo', { text: 'ping' }),
    ])
    expect(settled.status).toBe('done')

    const [turnEvent] = ofKind(events, 'turn.submitted')
    expect(turnEvent).toMatchObject({ status: 'ok', operationId: 'op-1', conversationId: '1' })
    expect(turnEvent?.attributes[RunAttribute.source]).toBe('direct')

    const attempts = ofKind(events, 'model.attempt')
    expect(attempts.map((event) => [event.status, event.attributes[RunAttribute.finishReason]])).toEqual([
      ['error', 'error'],
      ['ok', 'toolUse'],
      ['ok', 'stop'],
    ])
    expect(attempts.map((event) => event.attributes[RunAttribute.attempt])).toEqual([1, 2, 1])
    expect(attempts[0]?.attributes[RunAttribute.error]).toBe('Model provider failed.')
    expect(attempts.map((event) => event.attributes[RunAttribute.responseModel])).toEqual([
      model.id,
      model.id,
      model.id,
    ])
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ operationId: 'op-1', conversationId: '1' })
      expect(attempt.attributes).toMatchObject({
        [RunAttribute.provider]: 'openai',
        [RunAttribute.requestModel]: model.id,
        [RunAttribute.reasoningLevel]: 'off',
        [RunAttribute.inputTokens]: 10,
        [RunAttribute.outputTokens]: 5,
        [RunAttribute.cacheReadTokens]: 2,
      })
      expect(attempt.endedAt).toBeGreaterThanOrEqual(attempt.startedAt)
    }

    const [tool] = ofKind(events, 'tool.call')
    expect(tool).toMatchObject({ status: 'ok', operationId: 'op-1' })
    expect(tool?.attributes).toMatchObject({
      [RunAttribute.toolName]: 'echo',
      [RunAttribute.toolCallId]: 'call-echo',
      [RunAttribute.toolFamily]: 'builtin',
      [RunAttribute.argumentBytes]: JSON.stringify({ text: 'ping' }).length,
    })
    // Telemetry never carries content: no prompt, answer or tool text in any attribute.
    expect(JSON.stringify(events)).not.toMatch(/hello|ping|done"/u)
  })

  it('says what each event ran with: the release everywhere, and the endpoint of each model call (ADR 0107)', async () => {
    const release = 'a'.repeat(40)
    const env = {
      VITE_GOBLIN_BUILD: release,
      MODEL_BASE_URL: 'https://gateway.example.com/v1',
      MODEL_ID: model.id,
      MODEL_KEY: 'k',
    }
    const shared = await turn(
      [call('echo', { text: 'ping' })],
      'hello',
      'op-1',
      [],
      ranWith(env, () => false),
    )
    for (const event of shared.events) expect(event.attributes[RunAttribute.agentVersion]).toBe(release)
    for (const attempt of ofKind(shared.events, 'model.attempt'))
      expect(attempt.attributes).toMatchObject({
        [RunAttribute.modelEndpoint]: 'deployment',
        [RunAttribute.serverAddress]: 'gateway.example.com',
        [RunAttribute.serverPort]: 443,
      })
    for (const event of [...ofKind(shared.events, 'turn.submitted'), ...ofKind(shared.events, 'tool.call')])
      expect(Object.keys(event.attributes)).not.toContain(RunAttribute.modelEndpoint)

    const own = await turn(
      [],
      'hello',
      'op-1',
      [],
      ranWith(env, () => true),
    )
    const [attempt] = ofKind(own.events, 'model.attempt')
    expect(attempt?.attributes[RunAttribute.modelEndpoint]).toBe('owner')
    // The owner's endpoint is theirs: neither its address nor the deployment's is recorded for it.
    expect(Object.keys(attempt?.attributes ?? {})).not.toContain(RunAttribute.serverAddress)

    const none = await turn(
      [],
      'hello',
      'op-1',
      [],
      ranWith({}, () => false),
    )
    const [unset] = ofKind(none.events, 'model.attempt')
    expect(unset?.attributes[RunAttribute.modelEndpoint]).toBe('none')
    expect(Object.keys(unset?.attributes ?? {})).not.toContain(RunAttribute.agentVersion)
  })

  it('says which tools an attempt started with and gained, by name, never what they or the prompt say (ADR 0107)', async () => {
    const later = defineExtension({
      name: 'telemetry-later',
      tools: [
        defineTool({
          name: 'later',
          description: 'PRIVATE_TOOL_DESCRIPTION',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async () => ({ output: [{ type: 'text', text: 'ok' }] }),
        }),
      ],
    })
    const events = await twoTurns(later)
    const [first, second] = ofKind(events, 'model.attempt')
    expect(first?.attributes).toMatchObject({
      [RunAttribute.toolsAdded]: 4,
      [RunAttribute.toolsChanged]: 'echo,mcp_call,wait_grant,guarded',
    })
    expect(second?.attributes).toMatchObject({
      [RunAttribute.toolsAdded]: 1,
      [RunAttribute.toolsChanged]: 'later',
    })
    expect(Object.keys(second?.attributes ?? {})).not.toContain(RunAttribute.toolsRemoved)
    expect(JSON.stringify(events)).not.toContain('PRIVATE_')
  })

  it('records a failed task from when it was first seen, under the code it recorded, never its message', () => {
    const collected = new Collected()
    const at = { now: 1000 }
    const recorder = new PiRunRecorder(
      new RunTelemetry([collected], (id) => collected.read(id)),
      collected,
      () => at.now,
    )
    recorder.observe(commit(1, [personaTurn(12, { status: 'running', checkpoint: { phase: 'ask' } })]))
    at.now = 5000
    recorder.observe(
      commit(2, [
        personaTurn(12, {
          status: 'terminal',
          outcome: { status: 'failed', error: { message: 'PRIVATE_MESSAGE', detail: { code: 'no_answer' } } },
        }),
      ]),
    )
    const [failed] = ofKind(collected.events(), 'error')
    expect(failed).toMatchObject({
      status: 'error',
      startedAt: 1000,
      endedAt: 5000,
      attributes: { [RunAttribute.errorType]: 'no_answer', [RunAttribute.error]: 'The model gave no answer.' },
    })
    // A code telemetry does not know falls back to the error's type; a task first seen ended starts and ends at once.
    recorder.observe(
      commit(3, [
        personaTurn(13, {
          status: 'terminal',
          outcome: { status: 'failed', error: { message: 'x', detail: { code: 'made up' } } },
        }),
      ]),
    )
    expect(ofKind(collected.events(), 'error').at(-1)).toMatchObject({
      startedAt: 5000,
      endedAt: 5000,
      attributes: { [RunAttribute.errorType]: 'error' },
    })
    expect(JSON.stringify(collected.events())).not.toContain('PRIVATE_')
  })

  it('marks a restatement after compaction a baseline, counted and never named, and drops section text', () => {
    const collected = new Collected()
    const recorder = new PiRunRecorder(new RunTelemetry([collected], (id) => collected.read(id)), collected)
    const system = {
      role: 'system',
      content: '',
      sections: { persona: 'PRIVATE_SECTION_TEXT', memory: null },
      toolsAdded: [{ name: 'echo', description: 'PRIVATE_DESCRIPTION', parameters: {} }],
      toolsRemoved: [{ name: 'gone' }],
      timestamp: 1,
    }
    recorder.observe(
      commit(7, [
        {
          type: 'entry',
          value: { id: 40, conversationId: 1, kind: 'pi.system', byTaskId: 9, edits: [{ target: 3 }], model: [system] },
        },
        {
          type: 'task',
          value: {
            id: 9,
            conversationId: 1,
            kind: 'pi.generation',
            input: {},
            state: {
              status: 'running',
              checkpoint: {
                phase: 'request',
                attempt: 1,
                model: { provider: 'p', modelId: 'm' },
                thinkingLevel: 'low',
              },
            },
          },
        },
      ]),
    )
    const [attempt] = ofKind(collected.events(), 'model.attempt')
    expect(attempt?.attributes).toMatchObject({
      [RunAttribute.promptSections]: 'persona,memory',
      [RunAttribute.promptBaseline]: true,
      [RunAttribute.toolsAdded]: 1,
      [RunAttribute.toolsRemoved]: 1,
      [RunAttribute.reasoningLevel]: 'low',
    })
    expect(Object.keys(attempt?.attributes ?? {})).not.toContain(RunAttribute.toolsChanged)
    expect(JSON.stringify(collected.events())).not.toContain('PRIVATE_')
  })

  it('names the MCP server and tool of an mcp_call, and records its failure', async () => {
    const { events } = await turn([call('mcp_call', { connectionId: 'myplan', name: 'notes_search', arguments: {} })])
    const [tool] = ofKind(events, 'tool.call')
    expect(tool?.status).toBe('error')
    expect(tool?.attributes).toMatchObject({
      [RunAttribute.toolFamily]: 'mcp',
      [RunAttribute.mcpServer]: 'myplan',
      [RunAttribute.mcpTool]: 'notes_search',
    })
  })

  it('records a call a hook blocked, and a call to a tool that is not there', async () => {
    const blocked = await turn([call('guarded', {})])
    expect(ofKind(blocked.events, 'tool.call')).toMatchObject([
      { status: 'blocked', attributes: { [RunAttribute.blockedReason]: 'Execution blocked.' } },
    ])
    const missing = await turn([call('nonexistent', {})])
    expect(ofKind(missing.events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'tool_unavailable' } },
    ])
  })

  it('classifies owner grant waits and empty remote failures without copying private details', async () => {
    const blocked = await turn([call('wait_grant', {})])
    expect(ofKind(blocked.events, 'tool.call')).toMatchObject([
      {
        status: 'blocked',
        attributes: { [RunAttribute.errorType]: 'GrantDenied', [RunAttribute.blockedReason]: 'Owner grant required.' },
      },
    ])
    const failed = await turn([call('mcp_call', { connectionId: 'myplan', name: 'notes_search', arguments: {} })])
    expect(ofKind(failed.events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'tool_error', [RunAttribute.error]: 'Tool failed.' } },
    ])
  })

  it('records cutoffs and empty final answers without replaying them', async () => {
    const cutoff = await turn([{ content: [{ type: 'text', text: 'partial' }], stopReason: 'length' }])
    expect(ofKind(cutoff.events, 'model.attempt')).toMatchObject([
      { status: 'ok', attributes: { [RunAttribute.cutoff]: true, [RunAttribute.finishReason]: 'length' } },
    ])
    const empty = await turn([{ content: [], stopReason: 'stop' }])
    expect(ofKind(empty.events, 'model.attempt')).toMatchObject([
      { status: 'ok', attributes: { [RunAttribute.emptyAnswer]: true } },
    ])
    expect(ofKind(empty.events, 'model.attempt')).toHaveLength(1)
  })

  it('keeps the turn running when a sink throws', async () => {
    const failing: RunSink = {
      name: 'failing',
      started: () => {
        throw new Error('disk full')
      },
      ended: () => {
        throw new Error('disk full')
      },
    }
    const { settled, events } = await turn([call('echo', { text: 'x' })], 'hello', 'op-2', [failing])
    expect(settled.status).toBe('done')
    expect(ofKind(events, 'turn.submitted')).toMatchObject([{ status: 'ok', operationId: 'op-2' }])
  })
})

describe('run telemetry (unit)', () => {
  it('logs each ended event as one `run` line of ids, timing and allowlisted attributes', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const log = new RunLog(() => 'user-1')
      const ended: RunEvent = {
        id: 'tool:t1',
        kind: 'tool.call',
        status: 'error',
        conversationId: '1',
        operationId: 'source-12',
        taskId: 't1',
        startedAt: 10,
        endedAt: 250,
        attributes: { [RunAttribute.toolName]: 'mcp_call', [RunAttribute.errorType]: 'Internal', note: 'my notes' },
      }
      log.ended(ended)
      log.ended({ ...ended, id: 'tool:t2', status: 'blocked', attributes: { [RunAttribute.errorType]: 'GrantDenied' } })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        level: 'warn',
        event: 'run',
        kind: 'tool.call',
        status: 'error',
        agent: 'user-1',
        conversation: '1',
        operation: 'source-12',
        task: 't1',
        id: 'tool:t1',
        ms: 240,
        [RunAttribute.toolName]: 'mcp_call',
        [RunAttribute.errorType]: 'Internal',
      })
      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ level: 'info', id: 'tool:t2' })
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('names where a turn came from by its operation id', () => {
    expect(sourceOf('source-message-123')).toBe('source')
    expect(sourceOf('routine-input:rr_1:op')).toBe('routine')
    expect(sourceOf('subagent-report:7')).toBe('subagent_report')
    expect(sourceOf('subagent:7')).toBe('subagent')
    expect(sourceOf('persona:owner:op-3:2')).toBe('persona')
    // A thread start writes `thread-started:<chat>` passively; it never submits a turn, so it names no source.
    expect(sourceOf('thread-started:12')).toBe('direct')
    expect(sourceOf('5f0c2b9e-1d1e-4a7a-9f0e-1c1c1c1c1c1c')).toBe('direct')
  })

  it("names where a turn came from by its operation's receipt first (O2), its prefix only without one", () => {
    expect(sourceOf('op-1', { kind: 'ask_client', origin: 'client' })).toBe('client')
    expect(sourceOf('op-2', { kind: 'source', origin: 'source' })).toBe('source')
    expect(sourceOf('op-3', { kind: 'routine_input', origin: 'routine' })).toBe('routine')
    expect(sourceOf('op-4', { kind: 'subagent_report', origin: 'agent' })).toBe('subagent_report')
    // The owner's own send, whatever its id looks like; a passive write's receipt falls back to the prefix.
    expect(sourceOf('source-lookalike', { kind: 'send', origin: 'owner' })).toBe('direct')
    expect(sourceOf('persona:owner:op-3:2', { kind: 'write:app.note', origin: 'system' })).toBe('persona')
  })

  it('bounds attributes and marks what it shortened', () => {
    const bounded = boundAttributes({ [RunAttribute.error]: 'x'.repeat(2000), keep: 1 })
    expect(bounded).toEqual({ [RunAttribute.error]: 'Unclassified failure.' })
    const many = boundAttributes(Object.fromEntries(Object.values(RunAttribute).map((key) => [key, 'v'.repeat(160)])))
    expect(JSON.stringify(many).length).toBeLessThanOrEqual(2088)
    expect(many[RunAttribute.truncated]).toBe(true)
  })

  it('ends an event that started before a restart from the ledger, and says it resumed', () => {
    const collected = new Collected()
    const before = new RunTelemetry([collected], (id) => collected.read(id))
    before.begin({ id: 'turn:7', kind: 'turn.submitted', operationId: 'op', startedAt: 1, attributes: {} })
    // The restart sweep marks what was started as interrupted; a new object ends it when Pi settles it.
    const started = collected.read('turn:7')
    if (started === undefined) throw new Error('turn:7 was not recorded')
    collected.ended({ ...started, status: 'interrupted', endedAt: 2 })
    const after = new RunTelemetry([collected], (id) => collected.read(id))
    after.finish('turn:7', { status: 'ok', endedAt: 3 })
    expect(collected.read('turn:7')).toMatchObject({
      status: 'ok',
      startedAt: 1,
      endedAt: 3,
      attributes: { [RunAttribute.recovery]: 'resumed' },
    })
  })

  it('names the release on a recorded event and on one ended from its fallback, and records one whose stamp threw', () => {
    const collected = new Collected()
    const telemetry = new RunTelemetry(
      [collected],
      (id) => collected.read(id),
      ranWith({ VITE_GOBLIN_BUILD: 'b1' }, () => false),
    )
    telemetry.record({ id: 'restart:1', kind: 'recovery', status: 'ok', startedAt: 1, endedAt: 1, attributes: {} })
    telemetry.finish(
      'turn:9',
      { status: 'ok', endedAt: 3 },
      { id: 'turn:9', kind: 'turn.submitted', startedAt: 2, attributes: {} },
    )
    expect(collected.read('restart:1')?.attributes[RunAttribute.agentVersion]).toBe('b1')
    expect(collected.read('turn:9')?.attributes[RunAttribute.agentVersion]).toBe('b1')

    const broken = new Collected()
    const throwing = new RunTelemetry([broken], undefined, () => {
      throw new Error('storage reset')
    })
    throwing.record({ id: 'restart:2', kind: 'recovery', status: 'ok', startedAt: 1, endedAt: 1, attributes: {} })
    expect(broken.read('restart:2')?.status).toBe('ok')
  })

  it('keeps tokens and the finish reason when every drift attribute is at its bound (ADR 0107)', () => {
    const started = boundAttributes({
      [RunAttribute.agentVersion]: 'f'.repeat(40),
      [RunAttribute.operation]: 'chat',
      [RunAttribute.attempt]: 3,
      [RunAttribute.provider]: 'openai',
      [RunAttribute.requestModel]: 'm'.repeat(80),
      [RunAttribute.reasoningLevel]: 'xhigh',
      [RunAttribute.modelEndpoint]: 'deployment',
      [RunAttribute.serverAddress]: `${'h'.repeat(60)}.example.com`,
      [RunAttribute.serverPort]: 443,
      [RunAttribute.promptSections]: nameList(16, 17),
      [RunAttribute.promptBaseline]: true,
      [RunAttribute.toolsAdded]: 120,
      [RunAttribute.toolsRemoved]: 120,
      [RunAttribute.toolsChanged]: nameList(8, 36),
    })
    const ended = boundAttributes({
      ...started,
      [RunAttribute.responseModel]: 'm'.repeat(80),
      [RunAttribute.responseId]: 'r'.repeat(80),
      [RunAttribute.finishReason]: 'toolUse',
      [RunAttribute.inputTokens]: 123_456,
      [RunAttribute.outputTokens]: 12_345,
      [RunAttribute.cacheReadTokens]: 100_000,
      [RunAttribute.cacheWriteTokens]: 20_000,
      [RunAttribute.reasoningTokens]: 9_999,
      [RunAttribute.entry]: 123_456,
      [RunAttribute.firstPartialAt]: 1_760_000_000_000,
      [RunAttribute.cutoff]: true,
      [RunAttribute.recovered]: true,
    })
    expect(started[RunAttribute.promptSections]).toBe(nameList(16, 17))
    expect(ended).toMatchObject({
      [RunAttribute.finishReason]: 'toolUse',
      [RunAttribute.inputTokens]: 123_456,
      [RunAttribute.outputTokens]: 12_345,
      [RunAttribute.reasoningTokens]: 9_999,
    })
    expect(ended[RunAttribute.truncated]).toBeUndefined()
  })

  it('keeps only closed values for what a model call ran with', () => {
    expect(
      boundAttributes({
        [RunAttribute.modelEndpoint]: 'elsewhere',
        [RunAttribute.reasoningLevel]: 'ludicrous',
        [RunAttribute.serverAddress]: 'https://gateway.example.com/v1',
        [RunAttribute.serverPort]: 70_000,
      }),
    ).toEqual({})
    expect(
      boundAttributes({
        [RunAttribute.modelEndpoint]: 'owner',
        [RunAttribute.reasoningLevel]: 'xhigh',
        [RunAttribute.serverAddress]: 'gateway.example.com',
        [RunAttribute.serverPort]: 8443,
      }),
    ).toEqual({
      [RunAttribute.modelEndpoint]: 'owner',
      [RunAttribute.reasoningLevel]: 'xhigh',
      [RunAttribute.serverAddress]: 'gateway.example.com',
      [RunAttribute.serverPort]: 8443,
    })
  })
})

describe('run telemetry outside Pi (unit)', () => {
  it('records a cheap model call with its purpose and tokens, and a failed one', async () => {
    const collected = new CollectedRuns()
    const telemetry = new RunTelemetry([collected])
    let spent = 0
    const replies: Reply[] = [
      { content: [{ type: 'text', text: 'Trip plans' }], stopReason: 'stop' },
      { content: [], stopReason: 'error', errorMessage: 'HTTP 429 rate limited' },
    ]
    const namer = new CheapModel(
      cheapModels(replies),
      model.id,
      (use) => (spent += use.input + use.output + use.cacheRead + use.cacheWrite),
      auxReporter(telemetry, 'naming'),
    )
    await expect(namer.complete('Name this thread.', 'we talked about trips', 20)).resolves.toBe('Trip plans')
    await expect(namer.complete('Name this thread.', 'again', 20)).rejects.toMatchObject({
      _tag: 'ModelFailed',
      detail: 'HTTP 429 rate limited',
    })
    expect(spent).toBe(34)
    expect(collected.events()).toMatchObject([
      {
        kind: 'model.aux',
        status: 'ok',
        attributes: {
          [RunAttribute.purpose]: 'naming',
          [RunAttribute.inputTokens]: 10,
          [RunAttribute.outputTokens]: 5,
        },
      },
      {
        kind: 'model.aux',
        status: 'error',
        attributes: { [RunAttribute.purpose]: 'naming', [RunAttribute.error]: 'Model provider failed.' },
      },
    ])
    expect(JSON.stringify(collected.events())).not.toMatch(/trips|Trip plans/u)
  })

  it('records authorization waits as blocked and keeps logger failures separate from call results', async () => {
    const collected = new CollectedRuns()
    const report = mcpReporter(new RunTelemetry([collected]))
    await expect(
      step(
        { step: 'connect', connectionId: 'myplan' },
        () => Promise.reject(new NeedsAuthorization({ connectionId: 'myplan' })),
        report,
      ),
    ).rejects.toBeInstanceOf(NeedsAuthorization)
    expect(collected.events()).toMatchObject([
      { status: 'blocked', attributes: { [RunAttribute.errorType]: 'NeedsAuthorization' } },
    ])
    let calls = 0
    await expect(step({ step: 'call', connectionId: 'myplan' }, async () => ++calls, throwingReport)).resolves.toBe(1)
    const original = new NotFound({ what: 'fixture' })
    await expect(
      step({ step: 'call', connectionId: 'myplan' }, () => Promise.reject(original), throwingReport),
    ).rejects.toBe(original)
    expect(calls).toBe(1)
  })

  it('correlates explicit MCP scopes with exactly their tool tasks', () => {
    const collected = new CollectedRuns()
    const telemetry = new RunTelemetry([collected])
    const report = mcpReporter(telemetry)
    telemetry.begin({
      id: 'tool:one',
      kind: 'tool.call',
      conversationId: '1',
      operationId: 'one-op',
      taskId: 'one',
      startedAt: 1,
      attributes: {},
    })
    telemetry.begin({
      id: 'tool:two',
      kind: 'tool.call',
      conversationId: '2',
      operationId: 'two-op',
      taskId: 'two',
      startedAt: 1,
      attributes: {},
    })
    report({ step: 'call', connectionId: 'myplan', scope: { conversationId: '2', taskId: 'two' } }, 'ok', 2, 3)
    report({ step: 'call', connectionId: 'myplan', scope: { conversationId: '1', taskId: 'one' } }, 'ok', 2, 3)
    report({ step: 'connect', connectionId: 'myplan', sharedConnection: true }, 'ok', 2, 3)
    expect(ofKind(collected.events(), 'mcp.request')).toMatchObject([
      { operationId: 'two-op', conversationId: '2' },
      { operationId: 'one-op', conversationId: '1' },
      { attributes: { [RunAttribute.sharedConnection]: true } },
    ])
    expect(ofKind(collected.events(), 'mcp.request')[2]?.operationId).toBeUndefined()
  })

  it('records each remote MCP step, and a failed one by its tag', async () => {
    const collected = new CollectedRuns()
    const report = reaching(mcpReporter(new RunTelemetry([collected])), (connectionId) =>
      connectionId === 'myplan'
        ? { name: 'My Plan Server', version: '1.4.2', protocolVersion: '2025-11-25', toolsDigest: '1a2b3c4d-12' }
        : undefined,
    )
    await step({ step: 'call', connectionId: 'myplan', tool: 'notes_search' }, async () => 'ok', report)
    await expect(
      step(
        { step: 'connect', connectionId: 'myplan' },
        () => Promise.reject(new UpstreamMcp({ connectionId: 'myplan', reason: 'timeout' })),
        report,
      ),
    ).rejects.toThrow()
    expect(collected.events()).toMatchObject([
      {
        kind: 'mcp.request',
        status: 'ok',
        attributes: {
          [RunAttribute.mcpStep]: 'call',
          [RunAttribute.mcpServer]: 'myplan',
          [RunAttribute.mcpTool]: 'notes_search',
          [RunAttribute.mcpMethod]: 'tools/call',
          // What the server says it is, its name as an alias; never its address (ADR 0107).
          [RunAttribute.mcpServerName]: 'my_plan_server',
          [RunAttribute.mcpServerVersion]: '1.4.2',
          [RunAttribute.mcpProtocol]: '2025-11-25',
          [RunAttribute.mcpToolsDigest]: '1a2b3c4d-12',
        },
      },
      {
        kind: 'mcp.request',
        status: 'error',
        attributes: {
          [RunAttribute.mcpStep]: 'connect',
          [RunAttribute.mcpMethod]: 'initialize',
          [RunAttribute.errorType]: 'UpstreamMcp:timeout',
        },
      },
    ])
  })

  it("drops a server's self-reported version that is not a plain token", async () => {
    const collected = new CollectedRuns()
    const report = reaching(mcpReporter(new RunTelemetry([collected])), () => ({
      name: 'x',
      version: 'v1 (beta) build',
    }))
    await step({ step: 'events', connectionId: 'feed', method: 'events/poll' }, async () => 'ok', report)
    const [event] = collected.events()
    expect(event?.attributes).toMatchObject({
      [RunAttribute.mcpMethod]: 'events/poll',
      [RunAttribute.mcpServerName]: 'x',
    })
    expect(Object.keys(event?.attributes ?? {})).not.toContain(RunAttribute.mcpServerVersion)
  })
})
