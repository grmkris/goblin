import type { KeyOrigin, ThreadServer, ThreadServerView } from '@goblin/contracts'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { chatRow } from '../chats/directory.ts'
import { epochSeconds } from '../clock.ts'
import { Conflict, Forbidden, InvalidInput, NotFound, attempt, attemptSync } from '../http/errors.ts'
import { confineThreadServer, requestKey } from '../keys/policy.ts'
import { Db } from '../runtime/db.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { AgentInput } from '../runtime/input.ts'
import { appThreadServerOps, appThreadServers } from '../storage/thread-servers.ts'
import { type ArgumentChecks, checkArguments } from './connections/arguments.ts'
import { mapMcpError } from './connections/errors.ts'
import { bounded, toolOffered } from './connections/remote.ts'
import { Cipher } from './oauth/cipher.ts'

// The MCP servers a server's key declares on one of its threads (ADR 0103): checked against the key's granted origins
// (ADR 0091) when declared and again at every use, kept with their tokens encrypted, changed only by the newest
// operation, dropped when the thread closes or its Topic is archived, and called statelessly over Streamable HTTP by
// the thread's native Persona forks (ADR 0101, 0102).

type Database = DrizzleSqliteDODatabase

/** A declared server's id where a connection's would be (telemetry, results, refusals): `thread:<name>`. */
export const threadServerId = (name: string): string => `thread:${name}`

/** How long one request to a thread's server may take, the most its answer or its tool list may hold, and its pages. */
const TIMEOUT_MS = 90_000
const MAX_RESULT_BYTES = 1_048_576
const MAX_PAGES = 10

const decodeTools = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))
const toolsOf = (stored: string): readonly string[] => Option.getOrElse(decodeTools(stored), () => [])

type Row = typeof appThreadServers.$inferSelect

const viewOf = (row: Row): ThreadServerView => ({ name: row.name, url: row.url, tools: [...toolsOf(row.tools)] })

/** A thread's declared servers, by name. */
const rowsOf = (db: Database, chat: string): readonly Row[] =>
  db.select().from(appThreadServers).where(eq(appThreadServers.chatId, chat)).orderBy(appThreadServers.name).all()

/** A thread's declared servers as they are answered: never a token. */
export const threadServerViews = (db: Database, chat: string): readonly ThreadServerView[] =>
  rowsOf(db, chat).map(viewOf)

/** Whether a host is an IP literal: a thread's server is named by its host, never by an address. */
const ipLiteral = (host: string): boolean => host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}\.?$/u.test(host)

/**
 * A declared server's endpoint, checked: https, no credentials, query or fragment, a host that is a name. Its origin is
 * then checked against the key's (`confineThreadServer`), which is the network fence: an origin the owner grants is
 * never an IP literal or a local name (ADR 0091).
 */
const endpointOf = (url: string) =>
  Effect.gen(function* () {
    const refused = new InvalidInput({ reason: 'thread_server_url' })
    const parsed = yield* Effect.try({ try: () => new URL(url), catch: () => refused })
    const plain = parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.hash === ''
    if (parsed.protocol !== 'https:' || !plain || ipLiteral(parsed.hostname)) return yield* refused
    return parsed.href
  })

/** A declared server checked against the request's key: its endpoint, granted origin and the tools it may call. */
type Checked = { readonly name: string; readonly url: string; readonly origin: string; readonly tools: string[] }

/**
 * A change of a thread's servers, checked before anything is written: the key it is the request of (none for the
 * owner clearing them), each server against that key's origins, and the digest of what it declares, without tokens.
 */
export type Prepared = {
  readonly keyId: string | undefined
  readonly servers: readonly (Checked & { readonly token: string })[]
  readonly digest: string
}

/** The digest of a declaration: its servers' names, endpoints and tools, by name. Tokens are not part of it. */
const digestOf = (servers: readonly Checked[]) =>
  Effect.promise(() =>
    sha256Hex(
      JSON.stringify(
        servers
          .map(({ name, url, tools }) => ({ name, url, tools }))
          .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      ),
    ),
  )

/**
 * `servers` checked against the request's key, before any thread is made or changed: a key's alone (`key_only`), save
 * that the owner may clear a thread's servers with none; each endpoint https to a named host (`thread_server_url`); each
 * origin and tool within the key's grant (`key_origin`, `key_origin_tool`).
 */
export const prepareServers = Effect.fn('ThreadServers.prepare')(function* (servers: readonly ThreadServer[]) {
  const key = yield* requestKey
  if (key === undefined && servers.length > 0) return yield* new Forbidden({ reason: 'key_only' })
  const checked = yield* Effect.forEach(servers, (server) =>
    Effect.gen(function* () {
      const url = yield* endpointOf(server.url)
      const { origin, tools } = yield* confineThreadServer(url, server.tools)
      return { name: server.name, url, origin, tools: [...tools], token: server.token }
    }),
  )
  return { keyId: key?.keyId, servers: checked, digest: yield* digestOf(checked) } satisfies Prepared
})

/**
 * Whether `chat` is a thread that may declare servers: a Thread (made by a thread operation), never a Topic's
 * Conversation, main or a Persona's fork (`not_a_thread`).
 */
export const requireThread = (chat: string) =>
  Effect.gen(function* () {
    const row = yield* Db.useSync((db) => chatRow(db, chat))
    if (row === undefined) return yield* new NotFound({ what: 'conversation' })
    if (row.kind !== 'thread' || row.role !== null) return yield* new InvalidInput({ reason: 'not_a_thread' })
  })

/** What a stored token is bound to: the workspace, its thread, name and endpoint, so one copied elsewhere does not open. */
const aadOf = (workspace: string, chat: string, name: string, url: string): string =>
  `thread-server:${workspace}:${chat}:${name}:${url}`

/** How a change of a thread's servers went: made, its tokens swapped (the newest op again), or left (an older op). */
type Outcome = 'set' | 'rotated' | 'stale'

/** One write of a thread's servers: operation `operationId` setting `chat`'s to `prepared`, its tokens `sealed`. */
type Write = {
  readonly chat: string
  readonly operationId: string
  readonly prepared: Prepared
  readonly sealed: readonly string[]
  readonly now: number
}

/** The servers of the write's thread replaced by its own, the operation recorded as the newest after `seq`. */
const replaceAll = (tx: Database, { chat, operationId, prepared, sealed, now }: Write, seq: number) => {
  tx.delete(appThreadServers).where(eq(appThreadServers.chatId, chat)).run()
  for (const [index, server] of prepared.servers.entries())
    tx.insert(appThreadServers)
      .values({
        chatId: chat,
        name: server.name,
        url: server.url,
        origin: server.origin,
        tools: JSON.stringify(server.tools),
        token: sealed[index] ?? '',
        keyId: prepared.keyId ?? '',
        createdAt: now,
      })
      .run()
  tx.insert(appThreadServerOps)
    .values({ chatId: chat, operationId, digest: prepared.digest, seq: seq + 1, createdAt: now })
    .run()
}

/**
 * The write, in one step: a new operation replaces the servers and becomes the newest; the newest again with the same
 * digest swaps the tokens of the servers there; an older one with the same digest changes nothing; any operation with
 * another digest is a `Conflict` (`thread_servers`).
 */
const commit = (db: Database, write: Write): Outcome =>
  db.transaction((tx) => {
    const { chat, operationId, prepared, sealed } = write
    const ops = tx
      .select()
      .from(appThreadServerOps)
      .where(eq(appThreadServerOps.chatId, chat))
      .orderBy(desc(appThreadServerOps.seq))
      .all()
    const mine = ops.find((op) => op.operationId === operationId)
    if (mine === undefined) {
      replaceAll(tx, write, ops[0]?.seq ?? 0)
      return 'set'
    }
    if (mine.digest !== prepared.digest) throw new Conflict({ reason: 'thread_servers' })
    if (ops[0]?.operationId !== operationId) return 'stale'
    for (const [index, server] of prepared.servers.entries())
      tx.update(appThreadServers)
        .set({ token: sealed[index] ?? '' })
        .where(and(eq(appThreadServers.chatId, chat), eq(appThreadServers.name, server.name)))
        .run()
    return 'rotated'
  })

/**
 * Operation `operationId` changing `chat`'s servers to `prepared` (ADR 0103): their tokens sealed first, then checked
 * and written in one step (`commit`), so no change between the two is lost. The thread's servers as they are after.
 */
export const applyServers = Effect.fn('ThreadServers.apply')(function* (
  chat: string,
  operationId: string,
  prepared: Prepared,
) {
  const cipher = yield* Cipher
  const { workspaceId } = yield* AgentInput
  const sealed = yield* Effect.forEach(prepared.servers, (server) =>
    attempt(() => cipher.encrypt(server.token, aadOf(workspaceId, chat, server.name, server.url))),
  )
  const now = yield* epochSeconds
  const db = yield* Db
  yield* attemptSync(() => commit(db, { chat, operationId, prepared, sealed, now }))
  return threadServerViews(db, chat)
})

/**
 * Whether `prepared` could be written as `operationId` of `chat` now (`Conflict` otherwise), read before the rest of a
 * request writes anything; `applyServers` checks again as it writes.
 */
export const checkApply = (chat: string, operationId: string, prepared: Prepared) =>
  Effect.gen(function* () {
    const mine = yield* Db.useSync((db) =>
      db
        .select({ digest: appThreadServerOps.digest })
        .from(appThreadServerOps)
        .where(and(eq(appThreadServerOps.chatId, chat), eq(appThreadServerOps.operationId, operationId)))
        .get(),
    )
    if (mine !== undefined && mine.digest !== prepared.digest) return yield* new Conflict({ reason: 'thread_servers' })
  })

/** Drops the servers of `chats` (a closed thread and those under it): a closed thread keeps none, reopening none. */
export const dropThreadServers = (chats: readonly string[]) =>
  Db.useSync((db) => {
    if (chats.length > 0)
      db.delete(appThreadServers)
        .where(inArray(appThreadServers.chatId, [...chats]))
        .run()
  })

/** Drops the servers of every thread of Topic `topic`: an archived Topic's threads keep none. */
export const dropTopicServers = (topic: number) =>
  Db.useSync((db) => {
    for (const { chatId } of db.select({ chatId: appThreadServers.chatId }).from(appThreadServers).all())
      if (chatRow(db, chatId)?.topicId === topic)
        db.delete(appThreadServers).where(eq(appThreadServers.chatId, chatId)).run()
  })

/** One declared server, as a fork calls it: its endpoint, the tools it may call now, its token, opened, and its key. */
export type ThreadEndpoint = {
  readonly name: string
  readonly url: string
  readonly tools: readonly string[]
  readonly token: string
  readonly keyId: string
}

/**
 * The tools of `row` its key still grants (ADR 0091), checked live: none once the key is gone or expired, or no longer
 * grants its origin, and then every server that key declared on that origin (or on any, for a key that is gone) is
 * dropped, wherever it is.
 */
const stillGranted = (row: Row) =>
  Effect.gen(function* () {
    const { keyOrigins } = yield* AgentInput
    const origins: readonly KeyOrigin[] | undefined = yield* attempt(() => keyOrigins(row.keyId))
    const granted = origins?.find((each) => each.origin === row.origin)
    if (granted !== undefined) return toolsOf(row.tools).filter((tool) => granted.tools.includes(tool))
    const dropped =
      origins === undefined
        ? eq(appThreadServers.keyId, row.keyId)
        : and(eq(appThreadServers.keyId, row.keyId), eq(appThreadServers.origin, row.origin))
    yield* Db.useSync((db) => db.delete(appThreadServers).where(dropped).run())
    return yield* new Forbidden({ reason: 'key_origin' })
  })

/**
 * Server `name` of thread `chat`, its token opened and its tools narrowed to what its key still grants; `NotFound` once
 * it is dropped or replaced without that name, `Forbidden` once its key no longer grants it.
 */
export const threadEndpoint = Effect.fn('ThreadServers.endpoint')(function* (chat: string, name: string) {
  const row = yield* Db.useSync((db) => rowsOf(db, chat).find((each) => each.name === name))
  if (row === undefined) return yield* new NotFound({ what: `thread server ${name}` })
  const tools = yield* stillGranted(row)
  const cipher = yield* Cipher
  const { workspaceId } = yield* AgentInput
  const token = yield* attempt(() => cipher.decrypt(row.token, aadOf(workspaceId, chat, name, row.url)))
  return { name, url: row.url, tools, token, keyId: row.keyId } satisfies ThreadEndpoint
})

/** Every server of thread `chat` its key still grants, their tokens opened, for a fork's set. */
export const threadEndpoints = (chat: string) =>
  Effect.flatMap(
    Db.useSync((db) => rowsOf(db, chat)),
    (rows) =>
      Effect.map(
        Effect.forEach(rows, (row) =>
          threadEndpoint(chat, row.name).pipe(
            Effect.map(Option.some),
            // expected: a server its key no longer grants is dropped (`stillGranted`) and offers nothing.
            Effect.catchTag('Forbidden', () => Effect.succeed(Option.none())),
          ),
        ),
        (found) => found.flatMap((each) => (Option.isSome(each) ? [each.value] : [])),
      ),
  )

/**
 * One stateless session with `server`: a client opened over Streamable HTTP with its bearer token, the agent's own
 * fetch (redirects only within the origin, the transport's default), `use` run on it, and the client closed whatever
 * happens. A failure is the `UpstreamMcp` of the server's id, which never holds the token.
 */
const session = <A>(server: ThreadEndpoint, use: (client: Client, signal: AbortSignal) => Promise<A>) =>
  Effect.gen(function* () {
    const { mcpFetch } = yield* AgentInput
    const connectionId = threadServerId(server.name)
    return yield* Effect.tryPromise({
      try: async () => {
        const signal = AbortSignal.timeout(TIMEOUT_MS)
        const client = new Client(
          { name: 'goblin', version: '0.1.0' },
          { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
        )
        const transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { authorization: `Bearer ${server.token}` } },
          fetch: mcpFetch,
        })
        try {
          await client.connect(transport, { timeout: TIMEOUT_MS, signal })
          return await use(client, signal)
        } finally {
          // expected: a session that cannot close cleanly has nothing left to keep; the answer stands.
          await client.close().catch(() => undefined)
        }
      },
      catch: (error) => mapMcpError(error, connectionId),
    })
  })

/**
 * The tools `server` lists that the thread may call and the model may be offered, page by page up to
 * {@link MAX_PAGES}, the whole list at most {@link MAX_RESULT_BYTES} as JSON.
 */
export const threadTools = (server: ThreadEndpoint) =>
  session(server, async (client, signal) => {
    const connectionId = threadServerId(server.name)
    const tools: Tool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: TIMEOUT_MS,
        signal,
      })
      tools.push(...listed.tools)
      bounded(connectionId, tools, MAX_RESULT_BYTES)
      if (listed.nextCursor === undefined || listed.nextCursor === cursor) break
      cursor = listed.nextCursor
    }
    return tools.filter((tool) => server.tools.includes(tool.name) && toolOffered(tool, 'model'))
  })

/**
 * One call of `tool` on `server` with `args`, as a fork's native tool makes it: the tool must still be one the thread
 * may call, the arguments must fit its schema as the fork froze it (ADR 0092, checked again here whatever the model was
 * offered), and the answer is bounded.
 */
export const callThreadTool = (
  server: ThreadEndpoint,
  tool: { readonly name: string; readonly inputSchema: Readonly<Record<string, unknown>> },
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const connectionId = threadServerId(server.name)
    if (!server.tools.includes(tool.name)) return yield* new NotFound({ what: `tool ${tool.name}` })
    const checks: ArgumentChecks = new WeakMap()
    // SAFETY: a frozen schema is an object schema: `nativeSchema` refused any other when the fork froze it.
    const listed = { name: tool.name, inputSchema: tool.inputSchema as Tool['inputSchema'] }
    yield* checkArguments(checks, connectionId, listed, args)
    return yield* session(server, async (client, signal) => {
      const answer = await client.callTool({ name: tool.name, arguments: args }, { timeout: TIMEOUT_MS, signal })
      return bounded(connectionId, answer, MAX_RESULT_BYTES)
    })
  })
