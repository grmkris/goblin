import { createRegistry } from '@earendil-works/pi-durable'
import { type KeyOrigin, ThreadServers } from '@goblin/contracts'
import { ProtocolError, ProtocolErrorCode, createMcpHandler } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { Conversations } from '../src/chats/service.ts'
import { RequestContext } from '../src/http/api/context.ts'
import type { Caller } from '../src/http/api/principal.ts'
import type { AppError } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { CredentialCipher, Cipher } from '../src/mcp/oauth/cipher.ts'
import { McpConnections, McpGrants, McpServers, Resident } from '../src/mcp/service.ts'
import {
  type Prepared,
  applyServers,
  checkApply,
  dropThreadServers,
  prepareServers,
  requireThread,
  threadEndpoint,
  threadServerViews,
} from '../src/mcp/thread-servers.ts'
import { composeSet, forkToolsKit, freezeForkTools } from '../src/pi/fork-tools.ts'
import { RoutineRuns } from '../src/routines/service.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { Setups } from '../src/setup/service.ts'
import { CLOSED } from '../src/setup/scope.ts'
import { appKeyReach } from '../src/storage/keys.ts'
import { appPersonaChats } from '../src/storage/personas.ts'
import { appConversations } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { appThreadServers } from '../src/storage/thread-servers.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'
import { lowLevelServer } from './mcp/low-level-server.ts'
import { executeTool, inConversation } from './pi-tool.ts'

const ORIGIN = 'https://dev.swarmm.test'
const TOOLS = ['plan_propose', 'progress_report', 'delivery_submit', 'file_import']
/** A key the owner granted Swarmm's dev origin, with its four tools (ADR 0091). */
const KEY: Caller = {
  kind: 'key',
  keyId: 'key-1',
  scopes: ['conversations'],
  servers: [],
  origins: [{ origin: ORIGIN, tools: TOOLS }],
}
const CLIENT: Caller = { kind: 'client', clientId: 'claude', name: 'Claude Code', scopes: ['agent', 'conversations'] }

/** What each key grants now, as the auth store would answer it; a key not here is gone. */
const keys = new Map<string, readonly KeyOrigin[]>([['key-1', [{ origin: ORIGIN, tools: TOOLS }]]])

/** What the fixture server was called with: each call's tool, arguments and bearer. */
const received: { tool: string; args: unknown; authorization: string | null }[] = []
let bearer: string | null = null
/** How the fixture answers: as asked, with a JSON-RPC error, a 401, a dropped connection, or a huge tool list. */
type Mode = 'ok' | 'rpc' | 'unauthorized' | 'down' | 'huge' | 'redirect'
const answer: { mode: Mode } = { mode: 'ok' }
const DELIVER = {
  name: 'delivery_submit',
  description: 'Deliver the job.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
      },
      note: { type: 'string' },
    },
    required: ['items'],
  },
}
/** Two thousand tools of long words: well over 1 MiB as a list. */
const HUGE = Array.from({ length: 400 }, (_, i) => ({
  name: `t${String(i)}`,
  description: 'x'.repeat(4000),
  inputSchema: { type: 'object' as const },
}))
/** Swarmm's MCP server as a fixture: its job tools, one only its App may call, one the thread may not. */
const swarmm = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'swarmm', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () =>
    answer.mode === 'huge'
      ? { tools: HUGE }
      : {
          tools: [
            DELIVER,
            { name: 'progress_report', inputSchema: { type: 'object', properties: { milestone: { type: 'string' } } } },
            { name: 'plan_propose', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
            { name: 'admin_reset', inputSchema: { type: 'object' } },
          ],
        },
  )
  server.setRequestHandler('tools/call', (request) => {
    received.push({ tool: request.params.name, args: request.params.arguments, authorization: bearer })
    if (answer.mode === 'rpc')
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown file ${'f'.repeat(900)}`)
    return { content: [{ type: 'text', text: `swarmm ran ${request.params.name}` }] }
  })
  return server
})
/** Every host a request was sent to, with the bearer it carried. */
const hosts: { host: string; authorization: string | null }[] = []
const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  bearer = request.headers.get('authorization')
  hosts.push({ host: new URL(request.url).host, authorization: bearer })
  const calling = request.method === 'POST' && (await request.clone().text()).includes('tools/call')
  // A server that sends its calls elsewhere: the redirect is not followed off its origin.
  if (answer.mode === 'redirect' && calling)
    return new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/mcp' } })
  if (answer.mode === 'unauthorized' && calling) return new Response(null, { status: 401 })
  if (answer.mode === 'down' && calling) throw new TypeError('network down')
  return swarmm.fetch(request)
}

const database = chatDatabase()
const db = durable(database.db)
// Topic 2: its Conversation 19, the thread 20 a key declares Swarmm's server on, the fork 21 of Persona 5 answering
// there, and the fork 22 of Persona 6, which the key did not make.
db.insert(appConversations)
  .values([
    { chatId: '19', piSession: '19', kind: 'main', role: 'conversation', topicId: 2, createdAt: 1 },
    { chatId: '20', piSession: '20', kind: 'thread', parentSession: '19', topicId: 2, createdAt: 1 },
    { chatId: '21', piSession: '21', kind: 'thread', role: 'persona', parentSession: '20', topicId: 2, createdAt: 2 },
    { chatId: '22', piSession: '22', kind: 'thread', role: 'persona', parentSession: '20', topicId: 2, createdAt: 2 },
  ])
  .run()
db.insert(appPersonaChats)
  .values([
    { chatId: '21', personaId: 5, revision: 1, setup: '{}', createdAt: 2 },
    { chatId: '22', personaId: 6, revision: 1, setup: '{}', createdAt: 2 },
  ])
  .run()
db.insert(appKeyReach).values({ keyId: 'key-1', kind: 'persona', resourceId: 5, createdAt: 1 }).run()
db.insert(appTopics)
  .values({ id: 2, name: 'Customer', chatId: '19', createdBy: 'owner', createdAt: 1, updatedAt: 1 })
  .run()
const cipher = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
// SAFETY: these programs read nothing of the instance input but its MCP fetch, workspace and key origins.
const instance = {
  mcpFetch: fetcher,
  workspaceId: 'ws-1',
  keyOrigins: async (keyId: string) => keys.get(keyId),
} as AgentInputs
const base = Layer.mergeAll(
  sqliteDb(database.db),
  Layer.succeed(Cipher, cipher),
  Layer.succeed(AgentInput, instance),
  stub(Resident, { require: () => Effect.void }),
  stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
  stub(Conversations, { requireActing: (chat) => Effect.succeed(chat) }),
  // The forks hold none of the owner's connections: their tools are their thread's alone.
  stub(Setups, { scope: () => Effect.succeed(CLOSED) }),
  stub(McpServers, { list: () => Effect.succeed([]) }),
  stub(McpGrants, { list: () => Effect.succeed([]) }),
  stub(McpConnections),
)
/** `program` in a request `caller` sent (none: the owner's own), over the services above. */
const as = <A, E>(caller: Caller | undefined, program: Effect.Effect<A, E, AgentServices | RequestContext>) => {
  const context = Layer.succeed(RequestContext, {
    ref: undefined,
    request: undefined,
    operation: undefined,
    route: 'conversations.update',
    ...(caller === undefined ? {} : { caller }),
  })
  // SAFETY: the thread servers' programs need only the services provided here.
  return Effect.runPromise(Effect.provide(program, Layer.merge(base, context)) as Effect.Effect<A, E>)
}
const refusal = (
  caller: Caller | undefined,
  program: Effect.Effect<unknown, AppError, AgentServices | RequestContext>,
) =>
  as(
    caller,
    Effect.map(Effect.flip(program), (error) => ('reason' in error ? error.reason : error._tag)),
  )

type Declared = { name: string; url: string; token: string; tools: string[] }
const server = (extra: Partial<Declared> = {}): Declared => ({
  name: 'swarmm',
  url: `${ORIGIN}/api/mcp`,
  token: 'tok-1',
  tools: ['delivery_submit', 'progress_report'],
  ...extra,
})
/** Operation `op` of `caller` setting thread 20's servers to `servers`, as a change and a thread operation do. */
const set = (op: string, servers: readonly Declared[], caller: Caller | undefined = KEY) =>
  as(
    caller,
    Effect.gen(function* () {
      const prepared: Prepared = yield* prepareServers(servers)
      yield* checkApply('20', op, prepared)
      return yield* applyServers('20', op, prepared)
    }),
  )
const setRefused = (op: string, servers: readonly Declared[]) =>
  refusal(
    KEY,
    Effect.flatMap(prepareServers(servers), (prepared) => applyServers('20', op, prepared)),
  )
const checkRefused = (op: string, servers: readonly Declared[]) =>
  refusal(
    KEY,
    Effect.flatMap(prepareServers(servers), (prepared) => checkApply('20', op, prepared)),
  )
const token = async () => (await as(KEY, threadEndpoint('20', 'swarmm'))).token
const grantAll = () => keys.set('key-1', [{ origin: ORIGIN, tools: TOOLS }])

describe('a thread declares the MCP servers its Personas call (ADR 0103)', () => {
  it('refuses anyone but a key, an origin or tool the key was not granted, and an endpoint that is no https name', async () => {
    expect(await refusal(undefined, prepareServers([server()]))).toBe('key_only')
    expect(await refusal(CLIENT, prepareServers([server()]))).toBe('key_only')
    expect(await refusal(KEY, prepareServers([server({ url: 'https://evil.test/mcp' })]))).toBe('key_origin')
    expect(await refusal(KEY, prepareServers([server({ tools: ['admin_reset'] })]))).toBe('key_origin_tool')
    for (const url of [
      'http://dev.swarmm.test/mcp',
      'https://u:p@dev.swarmm.test/mcp',
      'https://dev.swarmm.test/mcp?token=x',
      'https://127.0.0.1/mcp',
      'https://[::1]/mcp',
      'not a url',
    ])
      expect(await refusal(KEY, prepareServers([server({ url })]))).toBe('thread_server_url')
    // The owner may clear a thread's servers, though never declare one.
    expect((await as(undefined, prepareServers([]))).servers).toEqual([])
  })

  it('takes at most four servers, each name once, never one that holds `__`', () => {
    const decode = Schema.decodeUnknownSync(ThreadServers)
    expect(() => decode([1, 2, 3, 4, 5].map((n) => server({ name: `s${String(n)}` })))).toThrow()
    expect(() => decode([server(), server()])).toThrow()
    expect(() => decode([server({ name: 'swarmm__x' })])).toThrow()
    expect(() => decode([server({ name: 'Swarmm' })])).toThrow()
    expect(decode([server(), server({ name: 'files' })])).toHaveLength(2)
  })

  it("declares on a Thread only: never a Topic's Conversation or a Persona's fork", async () => {
    await as(KEY, requireThread('20'))
    expect(await refusal(KEY, requireThread('19'))).toBe('not_a_thread')
    expect(await refusal(KEY, requireThread('21'))).toBe('not_a_thread')
  })

  it('keeps the token encrypted, bound to its workspace, thread, name and endpoint, and answers servers without it', async () => {
    const views = await set('op-enc', [server({ token: 'secret-token-1' })])
    expect(views).toEqual([{ name: 'swarmm', url: `${ORIGIN}/api/mcp`, tools: ['delivery_submit', 'progress_report'] }])
    const [row] = db.select().from(appThreadServers).all()
    expect(JSON.stringify(row)).not.toContain('secret-token-1')
    expect(row?.keyId).toBe('key-1')
    expect(await token()).toBe('secret-token-1')
    // Copied to another thread, or pointed at another endpoint, it does not open.
    if (row !== undefined)
      db.insert(appThreadServers)
        .values({ ...row, chatId: '99' })
        .run()
    expect(await refusal(KEY, threadEndpoint('99', 'swarmm'))).toBe('credential could not be decrypted')
    db.update(appThreadServers)
      .set({ url: `${ORIGIN}/other` })
      .run()
    expect(await refusal(KEY, threadEndpoint('20', 'swarmm'))).toBe('credential could not be decrypted')
    db.delete(appThreadServers).run()
  })

  it('lets only the newest operation change them: an older one replayed never undoes a later change', async () => {
    await set('op-2', [server({ token: 'a' })])
    await set('op-3', [server({ name: 'files', token: 'b' })])
    // op-2 again, the same: it answers with what stands and changes nothing.
    expect(await set('op-2', [server({ token: 'late' })])).toEqual([
      { name: 'files', url: `${ORIGIN}/api/mcp`, tools: ['delivery_submit', 'progress_report'] },
    ])
    // op-2 naming anything else is refused, before the request writes and as it writes.
    expect(await setRefused('op-2', [server({ url: `${ORIGIN}/elsewhere` })])).toBe('thread_servers')
    expect(await checkRefused('op-2', [server({ tools: ['plan_propose'] })])).toBe('thread_servers')
    // An empty set is an operation too: an older one replayed after it declares nothing again.
    await set('op-4', [])
    expect(threadServerViews(db, '20')).toEqual([])
    await set('op-3', [server({ name: 'files', token: 'b2' })])
    expect(threadServerViews(db, '20')).toEqual([])
  })

  it('swaps the tokens when the newest operation comes again with new ones, and revives nothing a close dropped', async () => {
    await set('op-5', [server({ token: 'first' })])
    await set('op-5', [server({ token: 'second' })])
    expect(await token()).toBe('second')
    // Closing drops them; the operation replayed after a reopen swaps tokens on nothing.
    await as(KEY, dropThreadServers(['20', '21']))
    await set('op-5', [server({ token: 'third' })])
    expect(threadServerViews(db, '20')).toEqual([])
    expect(await refusal(KEY, threadEndpoint('20', 'swarmm'))).toBe('NotFound')
  })

  it('never writes servers onto a thread closed while the change was in flight', async () => {
    db.update(appConversations).set({ closedAt: 5 }).where(eq(appConversations.chatId, '20')).run()
    expect(await setRefused('op-closed', [server()])).toBe('conversation_closed')
    expect(threadServerViews(db, '20')).toEqual([])
    db.update(appConversations).set({ closedAt: null }).where(eq(appConversations.chatId, '20')).run()
  })

  it('stops a server its key no longer grants, at every use, and drops it: a revoked key, or changed origins', async () => {
    await set('op-6', [server({ token: 'live' })])
    keys.set('key-1', [{ origin: ORIGIN, tools: ['delivery_submit'] }])
    expect((await as(KEY, threadEndpoint('20', 'swarmm'))).tools).toEqual(['delivery_submit'])
    keys.set('key-1', [{ origin: 'https://other.test', tools: TOOLS }])
    expect(await refusal(KEY, threadEndpoint('20', 'swarmm'))).toBe('key_origin')
    expect(threadServerViews(db, '20')).toEqual([])
    grantAll()
    await set('op-7', [server({ token: 'live' })])
    keys.delete('key-1')
    expect(await refusal(KEY, threadEndpoint('20', 'swarmm'))).toBe('key_origin')
    expect(db.select().from(appThreadServers).all()).toEqual([])
    grantAll()
  })
})

/** A tool that takes nothing. */
const bareTool = (name: string) => ({ name, inputSchema: { type: 'object' as const } })

describe('names, where a thread server and a connection meet (ADR 0103)', () => {
  it("leaves the owner's connection its name: a thread server declared as `mycut` takes the hash", () => {
    const built = composeSet([
      { connectionId: 'thread:mycut', serverName: 'mycut', tools: [bareTool('job_submit')], thread: 'mycut' },
      { connectionId: 'cut', serverName: 'MyCut', tools: [bareTool('job_submit')] },
    ])
    const names = Object.fromEntries(built.tools.map((each) => [each.connectionId, each.name]))
    expect(names['cut']).toBe('mycut__job_submit')
    expect(names['thread:mycut']).toMatch(/^mycut_[a-z0-9]{4}__job_submit$/u)
  })
})

/** Fork `fork`'s frozen set, installed, and its native tool `name`. */
const installedIn = async (fork: string) => {
  const frozen = await as(undefined, freezeForkTools(fork, { server: () => false, tool: () => false }))
  const registry = createRegistry()
  const kit = forkToolsKit(
    // SAFETY: the kit reads its storage only in `restore`, which this test never calls.
    {} as DurableObjectStorage,
    <A>(program: Effect.Effect<A, AppError, AgentServices>) => as(undefined, program),
  )
  kit.attach(registry)
  kit.install(frozen.set)
  const tool = (name: string) => {
    const found = registry
      .snapshot()
      .extension(`goblin.fork-tools:${frozen.set.id}`)
      ?.tools?.find((each) => each.name === name)
    if (found === undefined) throw new Error(`${name} is not installed`)
    return found
  }
  return { frozen, tool }
}

describe("a thread's Persona fork calls its declared server natively (ADR 0101, 0103)", () => {
  it('names its tools `<name>__<tool>`, offers only those the thread may call and the model may see', async () => {
    await set('op-8', [server({ token: 'job-token', tools: ['delivery_submit', 'progress_report', 'plan_propose'] })])
    const { frozen } = await installedIn('21')
    expect(frozen.set.tools.map((tool) => [tool.name, tool.connectionId, tool.thread])).toEqual([
      ['swarmm__delivery_submit', 'thread:swarmm', 'swarmm'],
      ['swarmm__progress_report', 'thread:swarmm', 'swarmm'],
    ])
    // A Persona the declaring key did not make gets none of them.
    expect((await installedIn('22')).frozen.set.tools).toEqual([])
  })

  it('calls with the live token, checks arguments first, and stops once its key is revoked', async () => {
    answer.mode = 'ok'
    await set('op-9', [server({ token: 'job-token' })])
    const deliver = (await installedIn('21')).tool('swarmm__delivery_submit')
    const result = await executeTool(deliver, { items: [{ fileId: 'f1' }], note: 'done' }, inConversation(21))
    expect(result.isError).toBe(false)
    expect(result.details).toMatchObject({ origin: { connectionId: 'thread:swarmm', trust: 'untrusted' } })
    expect(received.at(-1)).toEqual({
      tool: 'delivery_submit',
      args: { items: [{ fileId: 'f1' }], note: 'done' },
      authorization: 'Bearer job-token',
    })
    const calls = received.length
    const wrong = await executeTool(deliver, { items: [{}], note: 3 }, inConversation(21))
    expect(JSON.stringify(wrong.output)).toContain('/items/0')
    expect(JSON.stringify(wrong.output)).toContain('/note')
    expect(received).toHaveLength(calls)
    await set('op-10', [server({ token: 'rotated' })])
    await executeTool(deliver, { items: [{ fileId: 'f2' }] }, inConversation(21))
    expect(received.at(-1)?.authorization).toBe('Bearer rotated')
    keys.delete('key-1')
    const revoked = await executeTool(deliver, { items: [{ fileId: 'f3' }] }, inConversation(21))
    expect(revoked.isError).toBe(true)
    expect(received.at(-1)?.args).toEqual({ items: [{ fileId: 'f2' }] })
    grantAll()
  })

  it('never shows the token, whatever the server answers: a JSON-RPC error, a 401 or a dropped connection', async () => {
    await set('op-11', [server({ token: 'never-shown-token' })])
    const deliver = (await installedIn('21')).tool('swarmm__delivery_submit')
    for (const mode of ['rpc', 'unauthorized', 'down'] as const) {
      answer.mode = mode
      const result = await executeTool(deliver, { items: [{ fileId: 'f' }] }, inConversation(21))
      expect(result.isError, mode).toBe(true)
      expect(JSON.stringify(result), mode).not.toContain('never-shown-token')
    }
    // The server's own words reach the model bounded, as the server's.
    answer.mode = 'rpc'
    const said = JSON.stringify((await executeTool(deliver, { items: [{ fileId: 'f' }] }, inConversation(21))).output)
    expect(said).toContain('the server says')
    expect(said.length).toBeLessThan(1500)
    answer.mode = 'ok'
  })

  it("follows no redirect off the server's origin, and the bearer goes nowhere else", async () => {
    await set('op-13', [server({ token: 'stay-home' })])
    const deliver = (await installedIn('21')).tool('swarmm__delivery_submit')
    answer.mode = 'redirect'
    const result = await executeTool(deliver, { items: [{ fileId: 'f' }] }, inConversation(21))
    answer.mode = 'ok'
    expect(result.isError).toBe(true)
    expect(hosts.some((each) => each.host === 'elsewhere.test')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('stay-home')
  })

  it('offers nothing of a server whose tool list is over 1 MiB, and says it left it out', async () => {
    answer.mode = 'huge'
    await set('op-12', [server({ token: 't' })])
    const { frozen } = await installedIn('21')
    expect(frozen.set.tools).toEqual([])
    expect(frozen.left).toEqual([{ connectionId: 'thread:swarmm', reason: 'unlisted' }])
    answer.mode = 'ok'
  })
})
