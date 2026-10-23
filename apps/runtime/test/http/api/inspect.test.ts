import { InspectGroup } from '@goblin/contracts/api'
import { InspectFlows, InspectProblems, InspectTurns, OtlpTraceData, TurnTimeline } from '@goblin/contracts/inspect'
import type { RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { InspectHandlers } from '../../../src/inspect/api.ts'
import { Resident } from '../../../src/mcp/service.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { flowRunEvent } from '../../../src/telemetry/events.ts'
import { sqliteDb } from '../../chats-sqlite.ts'
import { credential, credentialHeaders, memoryGrants } from '../../grants-fixture.ts'
import { inspectionFixture } from '../../inspection-fixture.ts'
import { callOwner } from '../../owner-client.ts'
import { cleanup, currentResident, get as request, serve, served } from './fixture.ts'

/**
 * The inspect group as the agent serves it, over inspection of a real ledger (`inspectionFixture`: chat `12` is Pi
 * session `40`). The gate's resident authority is the only fake.
 */
const fixture = () => {
  const resident = currentResident()
  const inspection = inspectionFixture()
  cleanup(inspection.close)
  const grants = memoryGrants()
  const { fetch } = serve(
    served([InspectGroup], InspectHandlers, undefined, grants.layer).pipe(
      Layer.provide(
        Layer.mergeAll(inspection.layer, Layer.succeed(Resident, resident.service), sqliteDb(inspection.db)),
      ),
    ),
  )
  return { fetch, resident, ledger: inspection.ledger, db: inspection.db, grants }
}

/** A move from chat 12 into a new thread, recorded as its one flow step, and the answer of a turn there. */
const move = flowRunEvent(
  { flow: 'move', via: 'app', actor: 'owner', chat: '12', operationId: 'owner:op-9', status: 'ok' },
  'flow:1',
  1_000,
)
const answer = {
  id: 'model:t1:1:0',
  kind: 'model.attempt' as const,
  status: 'ok' as const,
  conversationId: '40',
  operationId: 'owner:op-8',
  taskId: 't1',
  startedAt: 900,
  endedAt: 950,
  attributes: { 'goblin.entry': 40 },
}

const get = (path: string) => request(path, { 'x-goblin-ref': 'ref-1' })

describe('the inspect group served by the agent', () => {
  it("answers a message's details by its operation or by its entry, and 404 for one it has none of", async () => {
    const { fetch, resident, ledger } = fixture()
    ledger.ended(move)
    ledger.ended(answer)
    const byOperation = await fetch(get('/api/inspect/details?operation=owner%3Aop-9'))
    expect(byOperation.status).toBe(200)
    expect(await byOperation.json()).toEqual({
      events: [move],
      coverage: { complete: true, gaps: [] },
      related: [],
    })
    const byEntry = await fetch(get('/api/inspect/details?chat=12&entry=40'))
    expect(await byEntry.json()).toMatchObject({ events: [{ operationId: 'owner:op-8' }], related: [] })
    const missing = await fetch(get('/api/inspect/details?chat=12&entry=41'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'That does not exist.', what: 'entry operation', ref: 'ref-1' },
    })
    expect(resident.grants).toHaveLength(3)
  })

  it('refuses a query naming neither an operation nor a chat entry, and one that does not decode (400)', async () => {
    const { fetch } = fixture()
    for (const query of ['', '?chat=12', '?entry=4'])
      expect(await (await fetch(get(`/api/inspect/details${query}`))).json()).toMatchObject({
        error: { code: 'invalid_input', reason: 'details take an operation, or a chat and an entry' },
      })
    for (const query of ['?chat=12&entry=0', '?chat=12&entry=forty', '?chat=main&entry=4'])
      expect(await (await fetch(get(`/api/inspect/details${query}`))).json()).toMatchObject({
        error: { code: 'invalid_input', reason: 'query does not match the expected shape' },
      })
    // The details under a chat's own path are gone with ADR 0086.
    const route = await fetch(get('/api/conversations/12/details?operation=op-1'))
    expect(route.status).toBe(404)
    expect(await route.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
  })

  it("serves the probes' typed client: details decode, and a refusal decodes as the NotFound class", async () => {
    const { fetch, ledger } = fixture()
    ledger.ended(move)
    const details = await callOwner({ fetch }, (api) => api.inspect.details({ query: { operation: 'owner:op-9' } }))
    expect(details.events.map((event) => event.id)).toEqual(['flow:1'])
    const refused = await callOwner({ fetch }, (api) =>
      Effect.flip(api.inspect.details({ query: { chat: '12', entry: 40 } })),
    )
    expect(refused).toMatchObject({ _tag: 'NotFound', what: 'entry operation', ref: 'integration-probe' })
  })
})

/** The key the edge forwards (ADRs 0081, 0114): its grant reads with `extras`, and lists its Topics. */
const KEY = credential({ id: 'key-1', name: 'swarmm', level: 'read', extras: ['inspect'], topics: 'list' })
const keyed = (extras: readonly ('inspect' | 'setup')[] = ['inspect']) => ({
  'x-goblin-ref': 'ref-1',
  ...credentialHeaders({ ...KEY, extras }),
})

/** A run event of operation `operationId` in Pi session `session`, from `start` to `end` ms, `ok`. */
const event = (
  id: string,
  kind: RunEvent['kind'],
  operationId: string,
  [session, start, end]: readonly [string, number, number],
  attributes: RunEvent['attributes'] = {},
): RunEvent => ({
  id,
  kind,
  status: 'ok',
  conversationId: session,
  operationId,
  startedAt: start,
  endedAt: end,
  attributes,
})

/** The body of `answered` decoded as `schema`. */
const decoded = async <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  answered: Promise<Response>,
) => Schema.decodeUnknownSync(schema)(await (await answered).json())

/** What a Persona's fork ran for the key's send `svc:job:1:first` (ADR 0033): two model attempts around one MyCut call. */
const FORK = 'persona:svc:job:1:first:7'
const forkTurn = [
  event('turn:fork', 'turn.submitted', FORK, ['41', 1_000, 61_000]),
  event('model:fork:1', 'model.attempt', FORK, ['41', 1_000, 11_000], {
    'gen_ai.request.model': 'qwen',
    'gen_ai.usage.input_tokens': 900,
    'gen_ai.usage.output_tokens': 40,
    'gen_ai.response.finish_reasons': 'toolUse',
    'goblin.first_partial_at': 3_000,
    'goblin.attempt': 1,
  }),
  event('tool:fork:1', 'tool.call', FORK, ['41', 11_000, 41_000], {
    'gen_ai.tool.name': 'mycut__job_submit',
    'goblin.mcp.server': 'mycut',
    'goblin.mcp.tool': 'job_submit',
  }),
  event('model:fork:2', 'model.attempt', FORK, ['41', 41_000, 51_000], {
    'gen_ai.request.model': 'qwen',
    'gen_ai.response.finish_reasons': 'stop',
  }),
]
const ask = flowRunEvent(
  { flow: 'persona_ask', via: 'mcp', actor: 'owner', chat: '12', operationId: 'svc:job:1:first', status: 'ok' },
  'flow:ask',
  900,
)

/**
 * The key reaches Topic 2: its thread `12` (Pi session `40`) and the Persona fork `13` (session `41`) under it. Main
 * (`1`) is Personal's and `14` (session `42`) another Topic's; the owner ran a turn in each.
 */
const keyFixture = () => {
  const { fetch, ledger, db, resident, grants } = fixture()
  db.insert(appConversations)
    .values([
      { chatId: '12', piSession: '40', kind: 'thread', topicId: 2, createdAt: 1 },
      { chatId: '13', piSession: '41', kind: 'thread', role: 'persona', parentSession: '12', topicId: 2, createdAt: 1 },
      { chatId: '14', piSession: '42', kind: 'main', role: 'conversation', topicId: 3, createdAt: 1 },
    ])
    .run()
  grants.set(KEY, [{ kind: 'topic', id: '2' }])
  for (const each of [...forkTurn, ask]) ledger.ended(each)
  ledger.ended(event('turn:main', 'turn.submitted', 'owner:op-1', ['1', 2_000, 3_000]))
  ledger.ended(event('turn:other', 'turn.submitted', 'owner:op-2', ['42', 2_000, 3_000]))
  ledger.ended({ ...event('tool:other', 'tool.call', 'owner:op-2', ['42', 2_100, 2_200]), status: 'error' })
  ledger.ended({
    ...event('tool:fork:bad', 'tool.call', FORK, ['41', 52_000, 53_000], { 'error.type': 'tool_error' }),
    status: 'error',
  })
  const read = (path: string, extras?: readonly ('inspect' | 'setup')[]) => fetch(request(path, keyed(extras)))
  return { fetch, read, resident }
}

describe("the inspect group under a server's API key whose grant lists its Topics (ADRs 0084, 0114)", () => {
  it("answers a Persona fork's turn by its operation: its steps in order and where its 60 seconds went", async () => {
    const { read, resident } = keyFixture()
    const answered = await read(`/api/inspect/turn?operation=${encodeURIComponent(FORK)}`)
    expect(answered.status).toBe(200)
    const timeline = Schema.decodeUnknownSync(TurnTimeline)(await answered.json())
    expect(timeline.steps.map((step) => [step.kind, step.offsetMs, step.ms])).toEqual([
      ['model.attempt', 0, 10_000],
      ['tool.call', 10_000, 30_000],
      ['model.attempt', 40_000, 10_000],
      ['tool.call', 51_000, 1_000],
    ])
    expect(timeline.steps[0]).toMatchObject({ model: 'qwen', inputTokens: 900, firstChunkMs: 2_000, attempt: 1 })
    expect(timeline.steps[1]).toMatchObject({ tool: 'mycut__job_submit', server: 'mycut', serverTool: 'job_submit' })
    expect(timeline.steps[3]).toMatchObject({ status: 'error', errorType: 'tool_error' })
    expect(timeline.spent).toEqual({
      totalMs: 60_000,
      modelMs: 20_000,
      toolMs: 31_000,
      servers: [{ server: 'mycut', calls: 1, ms: 30_000 }],
      otherMs: 9_000,
    })
    // Nothing a key reads grants resident authority.
    expect(resident.grants).toHaveLength(0)
  })

  it("answers its turn as an OpenTelemetry trace too, and another's not at all (ADR 0107)", async () => {
    const { read } = keyFixture()
    const trace = await decoded(
      OtlpTraceData,
      read(`/api/inspect/turn?operation=${encodeURIComponent(FORK)}&format=otlp`),
    )
    const names = trace.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
    )
    expect(names).toEqual([
      'invoke_agent goblin',
      'chat qwen',
      'execute_tool mycut__job_submit',
      'chat qwen',
      'execute_tool tool',
    ])
    expect((await read('/api/inspect/turn?operation=owner:op-1&format=otlp')).status).toBe(404)
  })

  it("lists and finds only what its own chats ran; the owner's and another Topic's are not there", async () => {
    const { read, fetch } = keyFixture()
    for (const operation of ['owner:op-1', 'owner:op-2'])
      expect((await read(`/api/inspect/turn?operation=${operation}`)).status).toBe(404)
    const turns = await decoded(InspectTurns, read('/api/inspect/turns?since=0'))
    expect(turns.turns.map((turn) => turn.operationId)).toEqual([FORK])
    const owned = await decoded(InspectTurns, fetch(request('/api/inspect/turns?since=0')))
    expect(owned.turns).toHaveLength(3)
    const problems = await decoded(InspectProblems, read('/api/inspect/problems?since=0&all=true'))
    expect(problems.problems.map((each) => each.id)).toEqual(['tool:fork:bad'])
    const flows = await decoded(InspectFlows, read('/api/inspect/flows?since=0'))
    expect(flows.flows.map((each) => each.operationId)).toEqual(['svc:job:1:first'])
    expect((await read('/api/inspect/turns?conversation=14')).status).toBe(404)
    expect((await read('/api/inspect/flows?chat=1')).status).toBe(404)
  })

  it("shows the details of its send with its Persona's answer related, and nothing outside its reach", async () => {
    const { read } = keyFixture()
    const details = await read('/api/inspect/details?operation=svc%3Ajob%3A1%3Afirst')
    expect(details.status).toBe(200)
    expect(await details.json()).toMatchObject({
      events: [{ id: 'flow:ask' }],
      related: [{ operation: FORK, kind: 'persona_answer' }],
    })
    const fork = await (await read(`/api/inspect/details?operation=${encodeURIComponent(FORK)}`)).json()
    expect(fork).toMatchObject({ turn: { operationId: FORK }, spent: { totalMs: 60_000 } })
    expect((await read('/api/inspect/details?operation=owner%3Aop-2')).status).toBe(404)
    expect((await read('/api/inspect/details?operation=owner%3Aop-1')).status).toBe(404)
    expect((await read('/api/inspect/details?chat=14&entry=1')).status).toBe(404)
  })

  it('reads in full only the conversations of the Topics it reaches', async () => {
    const { read } = keyFixture()
    expect((await read('/api/inspect/conversations')).status).toBe(200)
    expect((await read('/api/inspect/conversation?conversation=12')).status).toBe(200)
    const refused = await read('/api/inspect/conversation?conversation=14')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      error: { code: 'access_insufficient', missing: { reachId: 'w1/topic/3' } },
    })
  })

  it('is refused without the inspect extra before anything is read, with a link to widen it', async () => {
    const { read } = keyFixture()
    const refused = await read(`/api/inspect/turn?operation=${encodeURIComponent(FORK)}`, [])
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      error: {
        code: 'access_insufficient',
        missing: { extra: 'inspect' },
        widenUrl: 'https://goblin.test/consent/widen?grant=key-1&extra=inspect',
      },
    })
    expect((await read('/api/inspect/details?operation=svc%3Ajob%3A1%3Afirst', ['setup'])).status).toBe(403)
  })
})
