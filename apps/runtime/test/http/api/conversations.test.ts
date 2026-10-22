import type { FlowEvent } from '@goblin/contracts/telemetry'
import { Cipher } from '../../../src/mcp/oauth/cipher.ts'
import { ConversationView, runInput, threadStart } from '@goblin/contracts'
import { ConversationsGroup, InvalidInput, NotFound, UpstreamMcp } from '@goblin/contracts/api'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { Apps } from '../../../src/apps/service.ts'
import { Budget } from '../../../src/budget.ts'
import { scopeOf } from '../../../src/setup/scope.ts'
import { Setups } from '../../../src/setup/service.ts'
import { ConversationsHandlers } from '../../../src/chats/api.ts'
import { Files } from '../../../src/files/service.ts'
import { ChatOperationsLive, ChatsLive } from '../../../src/layers/conversation.ts'
import { McpConnections, McpGrants, McpServers, Resident } from '../../../src/mcp/service.ts'
import { Models } from '../../../src/models.ts'
import type { PersonaTurnKit } from '../../../src/organize/kit.ts'
import { Invocations, Personas } from '../../../src/personas/service.ts'
import { RunStreams, Streams } from '../../../src/streams/service.ts'
import type { PersonaView } from '@goblin/contracts'
import { Retrieval } from '../../../src/retrieval/service.ts'
import { RoutineControl, RoutineRuns } from '../../../src/routines/service.ts'
import { FlowEvents } from '../../../src/observability/flows.ts'
import { KeyedLock } from '../../../src/observability/lock.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import { Skills } from '../../../src/skills/service.ts'
import { Conversations, Moves, type ThreadAnchor } from '../../../src/chats/service.ts'
import { appChatOperations } from '../../../src/storage/chat-operations.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { callOwner } from '../../owner-client.ts'
import { currentResident, type Database, database, json, post, serve, served, sqliteDb, stub } from './fixture.ts'
import { fake } from '../../fake.ts'

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  topic: 1,
  createdAt: 1,
  keepOpen: false,
  replies: 0,
  ...extra,
})

/** The registry's chats: main, an open thread, a closed thread and a subagent. Each chat's Pi session is its id. */
const CHATS: Readonly<Record<string, ConversationView>> = {
  '1': {
    id: '1',
    kind: 'main',
    primary: true,
    conversation: true,
    topic: 1,
    createdAt: 1,
    keepOpen: false,
    replies: 0,
  },
  '2': view('2', { title: 'Plans' }),
  '3': view('3', { closedAt: 5, closedBy: 'owner' }),
  '4': view('4', { kind: 'subagent', title: 'scout', closedBy: 'done', closedAt: 6 }),
}
/** The Thread a create or a Thread start makes. */
const NEW = '9'

/** What the fakes were asked to do, in order. */
type Calls = string[]

const known = (id: string) =>
  Effect.suspend(() =>
    CHATS[id] === undefined && id !== NEW ? Effect.fail(new NotFound({ what: 'conversation' })) : Effect.succeed(id),
  )

/** A chat's Pi records as a forward read finds them: words, tool traffic, a question and a Persona's answer. */
const QUESTION = {
  id: 'q1',
  prompt: 'Which size?',
  kind: 'single',
  options: [
    { id: 'a', label: 'Square' },
    { id: 'b', label: 'Tall' },
  ],
}
const RECORDS = [
  { id: 4, kind: 'pi.user', model: [{ role: 'user', content: 'Plan my launch', timestamp: 1 }] },
  {
    id: 5,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Checking' }], stopReason: 'toolUse' }],
  },
  {
    id: 6,
    kind: 'pi.tool',
    model: [{ role: 'toolResult', toolName: 'web_fetch', content: 'secret page', details: {} }],
  },
  {
    id: 7,
    kind: 'pi.tool',
    model: [
      {
        role: 'toolResult',
        toolName: 'ask_user',
        content: 'Which size?',
        details: { kind: 'question', questions: [QUESTION] },
      },
    ],
  },
  {
    id: 8,
    kind: 'app.persona',
    data: {
      persona: 3,
      name: 'Squarewave',
      revision: 2,
      avatar: { glyph: 'S', hue: 10 },
      operationId: 'op-j',
      text: 'Cover ready',
    },
  },
  {
    id: 9,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Here is the plan' }], stopReason: 'stop' }],
  },
]

/** The registry's reads over `CHATS`. */
const registryReads = (): Partial<Conversations['Service']> => ({
  list: Effect.sync(() => Object.values(CHATS)),
  require: known,
  requireOpen: (id) =>
    Effect.flatMap(known(id), (chat) =>
      CHATS[chat]?.closedAt === undefined
        ? Effect.succeed(chat)
        : Effect.fail(new InvalidInput({ reason: 'conversation_closed' })),
    ),
  kindOf: (id) => Effect.map(known(id), (chat) => CHATS[chat]?.kind ?? 'thread'),
  view: (id) => Effect.sync(() => Option.fromNullishOr(id === NEW ? view(NEW, { forkEntry: 3 }) : CHATS[id])),
  subtree: (id) => Effect.succeed([id]),
  // SAFETY: the handler maps Pi's records to AG-UI messages; this one stands in for the owner's message before `before`.
  history: (_id, before) =>
    Effect.succeed({
      entries: [
        { id: before - 1, kind: 'pi.user', model: [{ role: 'user', content: 'older words', timestamp: 5 }] },
      ] as never,
      more: true,
    }),
  // SAFETY: as `history`: Pi's records are normalized by the handler; these stand in for them.
  after: (id, from) => Effect.map(known(id), () => RECORDS.filter((record) => record.id > from) as never),
})

/** How a recorded thread operation names its anchor. */
const anchorOf = (anchor: ThreadAnchor): string => (typeof anchor === 'string' ? anchor : String(anchor.entry))

/**
 * The registry's writes, recorded; a Thread start registers its Thread in the real directory, as the registry does, and
 * a repeat of its operation finds it. A create with an operation id is that chat's thread operation, as the registry's.
 */
const registryWrites = (db: Database, calls: Calls): Partial<Conversations['Service']> => {
  const startThread = (parent: string, operationId: string, anchor: ThreadAnchor) =>
    Effect.sync(() => {
      calls.push(`start:${parent}:${operationId}:${anchorOf(anchor)}`)
      db.insert(appConversations)
        .values({ chatId: NEW, piSession: NEW, kind: 'thread', parentSession: parent, createdAt: 2 })
        .onConflictDoNothing()
        .run()
      return view(NEW)
    })
  return {
    create: ({ from, operationId }) => {
      if (operationId !== undefined)
        return from === undefined
          ? startThread('1', operationId, 'empty')
          : startThread(from.conversation, operationId, { entry: from.entry })
      return Effect.succeed(
        from === undefined
          ? view(NEW, { parent: '1' })
          : view(NEW, { parent: from.conversation, forkEntry: from.entry }),
      )
    },
    update: (id, change) =>
      Effect.map(known(id), (chat) => ({
        view: view(chat, change.title === undefined ? {} : { title: change.title }),
        closed: [],
      })),
    // No thread here owes its announcement (ADR 0090), so naming one writes no note.
    announce: () => Effect.succeed(false),
    markRead: (id) => Effect.map(known(id), (chat) => void calls.push(`read:${chat}`)),
    startThread,
    stopSubagents: (id) => Effect.sync(() => void calls.push(`subagents:${id}`)),
  }
}

/** What reached Pi: owner inputs by session, and passive writes by conversation. */
type PiRecord = {
  readonly submitted: { readonly session: string; readonly operationId: string; readonly content: unknown }[]
  readonly writes: { readonly conversation: number; readonly requestId: string; readonly kind: string }[]
}

/** Pi's harness: it admits every input, holds one queued input and one passive write in each inbox, and aborts. */
const fakeHarness = (record: PiRecord, calls: Calls): PiHarness => {
  const conversation = (id: number) => ({
    submit: async (write: { readonly requestId: string; readonly entry: { readonly kind: string } }) => {
      record.writes.push({ conversation: id, requestId: write.requestId, kind: write.entry.kind })
      return { id: record.writes.length }
    },
    // A chat's first turn in the object's lifetime puts its tool filter right (ADR 0108).
    configure: async () => void calls.push(`configure:${String(id)}`),
  })
  const inbox = {
    items: [
      { id: 7, mode: 'followUp', content: 'later' },
      { id: 8, mode: 'write', content: 'passive' },
    ],
  }
  return fake<PiHarness>({
    submit: async (content, { session = '', operationId = '' } = {}) => {
      record.submitted.push({ session, operationId, content })
      return { session, operationId, accepted: true }
    },
    // SAFETY: the programs under test read only `conversation` (to submit and configure) and `snapshot` from Pi's own
    // harness.
    pi: async () => ({ conversation: async (id: number) => conversation(id), snapshot: async () => inbox }) as never,
    // SAFETY: a session is asked only for its events (the snapshot), whether it is busy, and to change model.
    session: (session) =>
      ({
        events: async () => ({ snapshot: { session, entries: [{ id: 1, kind: 'pi.user' }] }, stop: async () => {} }),
        busy: async () => false,
        setModel: async ({ id }: { readonly id: string }) => void calls.push(`model:${session}:${id}`),
      }) as never,
    abort: async ({ session = '' } = {}) => {
      calls.push(`abort:${session}`)
      return true
    },
  })
}

/** The other lanes' services the conversation programs read: everything allowed, nothing running, `personas` to tag. */
const services = (calls: Calls, personas: readonly PersonaView[]) =>
  Layer.mergeAll(
    // No request here declares a thread's servers (ADR 0102), so their tokens are never sealed or opened.
    stub(Cipher),
    // No message here carries files or App context, so neither is read.
    stub(Files),
    stub(Apps),
    // No request here joins a chat's stream or asks for a send's run as events.
    stub(Streams),
    stub(RunStreams),
    stub(Budget, { require: () => Effect.void }),
    stub(Models, { current: Effect.succeed('fixture-model') }),
    stub(RoutineRuns, { session: () => Effect.undefined }),
    stub(RoutineControl, { answer: () => Effect.succeed(false) }),
    stub(Invocations, {
      ofChat: (chat) =>
        Effect.succeed([
          {
            operationId: 'op-j',
            persona: 3,
            revision: 2,
            chat,
            order: 0,
            state: 'answered',
            answerEntry: 8,
            createdAt: 1,
          },
        ]),
      stopChat: (chat) => Effect.sync(() => calls.push(`invocations:${chat}`)),
      insert: (asked) =>
        Effect.sync(() => {
          calls.push(`asked:${asked.map(({ persona }) => persona).join(',')}`)
          return []
        }),
    }),
    stub(Personas, {
      active: Effect.succeed(personas),
      offers: () => Effect.succeed(false),
      ownModel: () => Effect.succeed(undefined),
    }),
    stub(Setups, { scope: () => Effect.succeed(scopeOf([], true)) }),
    // No servers, grants or connections: the composer offers none.
    stub(McpServers, { list: () => Effect.succeed([]) }),
    stub(McpGrants, { list: () => Effect.succeed([]) }),
    stub(McpConnections),
    stub(Skills, {
      catalog: () => Effect.succeed({ skills: [], unavailable: [] }),
      sources: () => Effect.succeed([]),
      // A skill on server `down` fails to load over the network; any other is not there.
      activateSelection: (_session, connectionId) =>
        connectionId === 'down'
          ? Effect.fail(new UpstreamMcp({ connectionId, reason: 'transport' }))
          : Effect.fail(new NotFound({ what: 'skill' })),
    }),
    stub(Retrieval, { uses: () => Effect.succeed([]) }),
  )

/** The instance's pieces the handlers read: Pi, the model choices and the Personas. */
const instance = (harness: PiHarness, calls: Calls) => {
  const personas = fake<PersonaTurnKit>({
    drop: async () => calls.push('personas:drop'),
    start: async (_pi, ask) => void calls.push(`personas:${ask.order}`),
  })
  return fake<AgentInputs>({
    harness,
    applied: new Map(),
    toolSets: { subagents: [], room: [] },
    retooled: new Set(),
    personas,
  })
}

/**
 * The conversations group as the agent serves it, running the conversation programs over a real chat directory and
 * the chat operations on SQLite. The registry, the mover, Pi and the instance are fakes that record what the programs
 * asked of them.
 */
const fixture = (options: { readonly personas?: readonly PersonaView[] } = {}) => {
  const db = database()
  const chats = Object.values(CHATS).map(({ id, kind, primary }) =>
    primary === true
      ? { chatId: id, piSession: id, kind, role: 'primary' as const, createdAt: 1 }
      : { chatId: id, piSession: id, kind, parentSession: '1', createdAt: 1 },
  )
  db.insert(appConversations).values(chats).run()
  const calls: Calls = []
  const flows: FlowEvent[] = []
  const record: PiRecord = { submitted: [], writes: [] }
  const harness = fakeHarness(record, calls)
  const resident = currentResident()
  const instances = Layer.mergeAll(
    stub(Conversations, { ...registryReads(), ...registryWrites(db, calls) }),
    stub(Moves, { move: (chat, input) => Effect.succeed({ ...input, chat, state: 'settled', thread: NEW }) }),
    Layer.succeed(Resident, resident.service),
    Layer.succeed(AgentInput, instance(harness, calls)),
  )
  // The chat directory and the chat operations as the agent builds them, over the core services and the stubs above.
  const core = Layer.mergeAll(
    sqliteDb(db),
    KeyedLock.layer,
    PiSessions.layer.pipe(Layer.provide(instances)),
    FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
  )
  const others = services(calls, options.personas ?? [])
  const directory = Layer.mergeAll(ChatsLive, ChatOperationsLive).pipe(
    Layer.provide(Layer.mergeAll(core, instances, others)),
  )
  const { fetch } = serve(
    served([ConversationsGroup], ConversationsHandlers).pipe(
      Layer.provide(Layer.mergeAll(directory, core, instances, others)),
    ),
  )
  const operations = () => db.select().from(appChatOperations).all()
  return { fetch, calls, record, resident, operations, flows }
}

/** A message that tags a skill of `connectionId`. */
const skill = (connectionId: string) =>
  runInput('2', {
    input: 'use it',
    operationId: `op-${connectionId}`,
    selections: [{ kind: 'skill', connectionId, uri: 'skill://plan' }],
  })

describe('the conversations API served by the agent', () => {
  it('creates a Thread with 201, empty or branched from an entry', async () => {
    const { fetch } = fixture()
    const empty = await fetch(post('/api/conversations', {}))
    expect(empty.status).toBe(201)
    expect(await empty.json()).toMatchObject({ id: NEW, parent: '1' })
    const branched = await fetch(post('/api/conversations', { from: { conversation: '2', entry: 4 } }))
    expect(branched.status).toBe(201)
    expect(await branched.json()).toMatchObject({ id: NEW, parent: '2', forkEntry: 4 })
  })

  it("sends the owner's message with 202 and Pi's receipt, admitted once per operation", async () => {
    const { fetch, record, operations, resident } = fixture()
    const response = await fetch(
      post('/api/conversations/2/messages', runInput('2', { input: 'hello', operationId: 'op-1' }), {
        'x-goblin-ref': 'r-1',
      }),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ operationId: 'op-1', session: '2', accepted: true })
    expect(response.headers.get('x-goblin-ref')).toBe('r-1')
    expect(record.submitted).toEqual([{ session: '2', operationId: 'op-1', content: 'hello' }])
    expect(operations()).toEqual([expect.objectContaining({ chatId: '2', operationId: 'op-1', sessionId: '2' })])
    expect(resident.grants).toHaveLength(1)
  })

  it('refuses an empty or closed send (400), an unknown chat (404) and a path id or body that does not decode', async () => {
    const { fetch, record } = fixture()
    const answers = [
      ['/api/conversations/2/messages', runInput('2', { input: '  ', operationId: 'op-1' }), 400, 'empty_message'],
      [
        '/api/conversations/3/messages',
        runInput('3', { input: 'hi', operationId: 'op-2' }),
        400,
        'conversation_closed',
      ],
      ['/api/conversations/77/messages', runInput('77', { input: 'hi', operationId: 'op-3' }), 404, undefined],
      ['/api/conversations/abc/messages', runInput('abc', { input: 'hi', operationId: 'op-4' }), 404, undefined],
      [
        '/api/conversations/2/messages',
        { input: 'hi', operationId: 'op-5' },
        400,
        'body does not match the expected shape',
      ],
      ['/api/conversations/2/messages', runInput('3', { input: 'hi', operationId: 'op-6' }), 400, 'thread_mismatch'],
    ] as const
    for (const [path, body, status, reason] of answers) {
      const response = await fetch(post(path, body))
      expect(response.status).toBe(status)
      if (reason !== undefined) expect(await response.json()).toMatchObject({ error: { reason } })
    }
    expect(record.submitted).toEqual([])
  })

  it('refuses a selection that is not there as its own InvalidInput, but passes any other failure on as it is (C1)', async () => {
    const { fetch, record } = fixture()
    const gone = await fetch(post('/api/conversations/2/messages', skill('gone')))
    expect(gone.status).toBe(400)
    expect(await gone.json()).toMatchObject({ error: { reason: 'composer:skill:gone:skill://plan' } })
    const down = await fetch(post('/api/conversations/2/messages', skill('down')))
    expect(down.status).toBeGreaterThanOrEqual(500)
    expect(await down.json()).toMatchObject({
      error: { code: 'upstream_mcp', connectionId: 'down', reason: 'transport' },
    })
    expect(record.submitted).toEqual([])
  })

  it('starts a Thread with 201 in one call: the head goes into the chat, the first message into the Thread', async () => {
    const { fetch, calls, record, operations, flows } = fixture()
    const body = threadStart('1', { operationId: 'op-t', anchor: 'latest', message: { input: 'plan it' } })
    const response = await fetch(post('/api/conversations/1/threads', body))
    expect(response.status).toBe(201)
    const started = Schema.decodeUnknownSync(Schema.Struct({ thread: ConversationView, receipt: Schema.Unknown }))(
      await response.json(),
    )
    expect(started.thread).toMatchObject({ id: NEW, forkEntry: 3 })
    expect(started.receipt).toEqual({ operationId: 'op-t:first', session: NEW, accepted: true })
    expect((await fetch(post('/api/conversations/1/threads', body))).status).toBe(201)
    expect(calls.filter((call) => call.startsWith('start:'))).toEqual(['start:1:op-t:latest', 'start:1:op-t:latest'])
    expect(record.writes).toEqual([
      { conversation: 1, requestId: 'thread-head:op-t', kind: 'app.thread_head' },
      { conversation: 1, requestId: 'thread-head:op-t', kind: 'app.thread_head' },
    ])
    expect(record.submitted.map(({ session, operationId }) => [session, operationId])).toEqual([
      [NEW, 'op-t:first'],
      [NEW, 'op-t:first'],
    ])
    expect(operations()).toEqual([
      expect.objectContaining({
        chatId: '1',
        operationId: 'thread-head:op-t',
        kind: 'write:app.thread_head',
        parentOp: 'op-t',
      }),
      expect.objectContaining({
        chatId: NEW,
        operationId: 'op-t:first',
        kind: 'send',
        parentOp: 'op-t',
        state: 'submitted',
      }),
    ])
    expect(flows.map(({ flow, status }) => [flow, status])).toEqual([
      ['send', 'ok'],
      ['send', 'replayed'],
    ])
  })

  it('replies at an entry and starts "+" empty with no head; a create with an operation id is the same operation (C4)', async () => {
    const { fetch, calls, record } = fixture()
    const reply = threadStart('2', { operationId: 'op-r', anchor: { entry: 4 }, message: { input: 'about this' } })
    expect((await fetch(post('/api/conversations/2/threads', reply))).status).toBe(201)
    const plus = threadStart('1', { operationId: 'op-e', anchor: 'empty', message: { input: 'new idea' } })
    expect((await fetch(post('/api/conversations/1/threads', plus))).status).toBe(201)
    expect(record.writes).toEqual([])
    expect(record.submitted.map(({ operationId }) => operationId)).toEqual(['op-r:first', 'op-e:first'])
    expect((await fetch(post('/api/conversations', { operationId: 'op-c' }))).status).toBe(201)
    const from = { operationId: 'op-b', from: { conversation: '2', entry: 4 } }
    expect((await fetch(post('/api/conversations', from))).status).toBe(201)
    expect(calls.filter((call) => call.startsWith('start:'))).toEqual([
      'start:2:op-r:4',
      'start:1:op-e:empty',
      'start:1:op-c:empty',
      'start:2:op-b:4',
    ])
  })

  it('starts a Thread whose tagged Personas answer there in the order the message asks (H1)', async () => {
    const ada = fake<PersonaView>({
      id: 5,
      name: 'Ada',
      revision: 2,
      role: 'critic',
      instructions: 'Brief.',
      setup: { mcpServers: [], skills: [], apps: [] },
    })
    const { fetch, calls, record } = fixture({ personas: [ada] })
    const message = { input: 'compare them', selections: [{ kind: 'persona' as const, personaId: 5 }] }
    const body = threadStart('1', { operationId: 'op-p', anchor: 'latest', message, personaOrder: 'sequence' })
    const response = await fetch(post('/api/conversations/1/threads', body))
    expect(response.status).toBe(201)
    // The Thread's tool filter is put right before the ask, so the forks copy it (ADR 0108).
    expect(calls).toEqual(['start:1:op-p:latest', 'asked:5', 'configure:9', 'personas:sequence'])
    expect(record.writes.map(({ conversation, kind }) => [conversation, kind])).toEqual([
      [1, 'app.thread_head'],
      [9, 'app.persona_ask'],
    ])
    expect(record.submitted).toEqual([])
  })

  it('stops a chat, marks it read and renames it', async () => {
    const { fetch, calls, flows } = fixture()
    const stop = await fetch(post('/api/conversations/2/stop', {}))
    expect(stop.status).toBe(200)
    expect(await stop.json()).toEqual({ stopped: true })
    expect(calls).toEqual(['subagents:2', 'personas:drop', 'invocations:2', 'abort:2'])
    expect(flows).toEqual([{ flow: 'stop', via: 'app', actor: 'owner', chat: '2', count: 1, status: 'ok' }])
    const read = await fetch(json('PUT', '/api/conversations/2/read', {}))
    expect(await read.json()).toEqual({ read: true })
    expect(calls).toContain('read:2')
    const renamed = await fetch(json('PATCH', '/api/conversations/2', { title: 'Trips' }))
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ id: '2', title: 'Trips' })
  })

  it('reads history before an entry as AG-UI messages, and the sources of a registered chat', async () => {
    const { fetch } = fixture()
    const page = await fetch(json('GET', '/api/conversations/2/history?before=10'))
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({
      messages: [
        {
          id: '2:e9',
          role: 'user',
          content: 'older words',
          metadata: { goblin: { entryId: 9, at: 5, branchable: true } },
        },
      ],
      next: 9,
      more: true,
    })
    for (const query of ['?before=0', '?before=x', '?before=1.5', ''])
      expect((await fetch(json('GET', `/api/conversations/2/history${query}`))).status).toBe(400)
    expect((await fetch(json('GET', '/api/conversations/77/history?before=10'))).status).toBe(404)
    expect(await (await fetch(json('GET', '/api/conversations/2/sources'))).json()).toEqual([])
  })

  it('reads entries after a cursor, oldest first and normalized, with the activity and invocations (ADR 0081)', async () => {
    const { fetch } = fixture()
    const first = await fetch(json('GET', '/api/conversations/2/entries?after=3&limit=4'))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      entries: [
        { kind: 'message', id: 4, role: 'owner', text: 'Plan my launch', final: true },
        { kind: 'message', id: 5, role: 'agent', text: 'Checking', final: false },
        { kind: 'question', id: 7, questions: [QUESTION] },
      ],
      next: 7,
      more: true,
      activity: 'idle',
      invocations: [expect.objectContaining({ operationId: 'op-j', state: 'answered', answerEntry: 8 })],
    })
    const rest = await (await fetch(json('GET', '/api/conversations/2/entries?after=7'))).json()
    expect(rest).toMatchObject({
      entries: [
        {
          kind: 'persona',
          id: 8,
          persona: { id: 3, name: 'Squarewave', revision: 2 },
          operationId: 'op-j',
          text: 'Cover ready',
        },
        { kind: 'message', id: 9, role: 'agent', text: 'Here is the plan', final: true },
      ],
      next: 9,
      more: false,
    })
    expect(JSON.stringify(rest)).not.toContain('secret page')
    expect(await (await fetch(json('GET', '/api/conversations/2/entries?after=9'))).json()).toMatchObject({
      entries: [],
      next: 9,
      more: false,
    })
    for (const query of ['', '?after=-1', '?after=x', '?after=1&limit=0', '?after=1&limit=101'])
      expect((await fetch(json('GET', `/api/conversations/2/entries${query}`))).status).toBe(400)
    expect((await fetch(json('GET', '/api/conversations/77/entries?after=0'))).status).toBe(404)
  })

  it("lists the owner's queued inputs, answers a move's receipt and reads the composer; switches are gone", async () => {
    const { fetch } = fixture()
    const queue = await fetch(json('GET', '/api/conversations/2/queue'))
    expect(await queue.json()).toEqual({ inputs: [{ id: 7, mode: 'followUp', content: 'later' }] })
    const subagent = await fetch(json('GET', '/api/conversations/4/queue'))
    expect(await subagent.json()).toEqual({ inputs: [] })
    const move = await fetch(post('/api/conversations/1/move', { entry: 5, operationId: 'move-1' }))
    expect(await move.json()).toEqual({
      operationId: 'move-1',
      chat: '1',
      state: 'settled',
      thread: NEW,
    })
    const composer = await fetch(json('GET', '/api/conversations/2/composer'))
    expect(await composer.json()).toEqual({
      options: [
        {
          selection: { kind: 'subagent', conversationId: '4' },
          label: 'scout',
          description: 'Done · Reference here',
        },
      ],
      unavailable: [],
    })
    const switches = await fetch(json('GET', '/api/conversations/2/capabilities'))
    expect(switches.status).toBe(404)
  })

  it("serves the probes' typed client: a refusal decodes as the InvalidInput class with its reference", async () => {
    const agent = fixture()
    const receipt = await callOwner(agent, (api) =>
      api.conversations.submit({ params: { id: '2' }, payload: runInput('2', { input: 'hi', operationId: 'op-c' }) }),
    )
    expect(receipt).toEqual({ operationId: 'op-c', session: '2', accepted: true })
    const refused = await callOwner(agent, (api) =>
      Effect.flip(
        api.conversations.submit({ params: { id: '3' }, payload: runInput('3', { input: 'hi', operationId: 'op-d' }) }),
      ),
    )
    expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'conversation_closed', ref: 'integration-probe' })
    const page = await callOwner(agent, (api) =>
      api.conversations.history({ params: { id: '2' }, query: { before: 3 } }),
    )
    expect(page).toMatchObject({
      messages: [{ id: '2:e2', role: 'user', content: 'older words' }],
      next: 2,
      more: true,
    })
  })
})
