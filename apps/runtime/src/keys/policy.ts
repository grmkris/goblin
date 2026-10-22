import {
  type SetupItem,
  type StreamTier,
  type TopicSetup,
  type TopicSetupEdit,
  type WorkspaceRole,
  clientAuthor,
  memberAuthor,
  serverAuthor,
  serverOriginOf,
} from '@goblin/contracts'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { chatOfSession, chatRow } from '../chats/directory.ts'
import { Chats } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { RequestContext } from '../http/api/context.ts'
import type { KeyGrant } from '../http/api/principal.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { Place, Reach } from '../inspect/service.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { type ReachKind, hasReach, recordReach, roomOf } from './reach.ts'

/**
 * What a server's API key may do inside the agent (ADR 0081): reach only the Topics, their chats and the Personas it
 * made, and write setups under its server ceiling. Every program here does nothing for the owner's own session.
 */

/** The request's caller (ADR 0086); none for the owner's session or work outside a request. */
const requestCaller = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => Option.getOrUndefined(context)?.caller,
)

/**
 * The key the current request came with; none for the owner's session, an OAuth client of the owner (which reaches what
 * the owner does) or work outside a request.
 */
export const requestKey: Effect.Effect<KeyGrant | undefined> = Effect.map(requestCaller, (caller) =>
  caller?.kind === 'key' ? caller : undefined,
)

/**
 * The tier of a chat's stream the current request reads (docs/architecture/streams.md): a member's session and an OAuth
 * client holding `transcripts` read `full`; a server's key and any other client read `answers`.
 */
export const requestTier: Effect.Effect<StreamTier> = Effect.map(requestCaller, (caller) =>
  caller === undefined || (caller.kind === 'client' && caller.scopes.includes('transcripts')) ? 'full' : 'answers',
)

/**
 * The role of the member the current request acts for (ADR 0093), from their browser or a client acting for them; none
 * for a server's key or work outside a request (a Source, a routine, the system).
 */
export const requestRole: Effect.Effect<WorkspaceRole | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => Option.getOrUndefined(context)?.member?.role,
)

/**
 * A change to what the agent works with (ADR 0098), here a Topic's guidance or setup: it takes an owner or an admin, so
 * a member's request, from their browser or a client acting for them, is `Forbidden` `role`. A key's passes, its own
 * policy bounding it, and so does anything else no member sent.
 */
export const requireAdminFor = (configures: boolean): Effect.Effect<void, Forbidden> =>
  configures
    ? Effect.flatMap(requestRole, (role) =>
        role === 'member' ? Effect.fail(new Forbidden({ reason: 'role' })) : Effect.void,
      )
    : Effect.void

/**
 * Where a request's flow comes from (ADR 0037): a caller's (ADR 0086: an OAuth client or a server's key) is an MCP
 * client's, anyone else's the owner's in the app.
 */
export const requestFlowOrigin: Effect.Effect<{ readonly via: 'app' | 'mcp'; readonly actor: 'owner' | 'client' }> =
  Effect.map(requestCaller, (caller) =>
    caller === undefined ? ({ via: 'app', actor: 'owner' } as const) : ({ via: 'mcp', actor: 'client' } as const),
  )

/**
 * Who a request's message is by, which its content carries first: a server's key by its name (ADR 0108), an OAuth
 * client by the name it registered (ADR 0086, and for whom in a workspace of several people), or in such a workspace a
 * member by name and ID (ADR 0094); none for a member alone in their workspace, or any other request.
 */
export const requestAuthor: Effect.Effect<string | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => {
    const facts = Option.getOrUndefined(context)
    const member = facts?.member
    const caller = facts?.caller
    if (caller?.kind === 'key') return serverAuthor(caller.name)
    if (caller?.kind === 'client') return clientAuthor(caller.name, member?.shared === true ? member.name : undefined)
    if (caller === undefined && member?.shared === true) return memberAuthor(member.name, member.user)
    return undefined
  },
)

/**
 * Whether work in Topic `topic` is a server's (ADR 0087): it comes through a key, or the Topic is a room (a key made
 * it, ADR 0108), whoever works there. It never runs on the owner's own subscriptions.
 */
export const serverWorkIn = (db: DrizzleSqliteDODatabase, topic: number): Effect.Effect<boolean> =>
  Effect.map(requestKey, (key) => key !== undefined || roomOf(db, topic))

/** A Topic a key's create makes when its body names no setup: nothing but its own chats. */
export const KEY_TOPIC_SETUP: TopicSetup = { mcpServers: [], skills: [], apps: [], subagents: false }

const reached = (key: KeyGrant, kind: ReachKind, id: number) => Db.useSync((db) => hasReach(db, key.keyId, kind, id))

/** Out of a key's reach, a Topic or Persona is as if it were not there. */
const confine = (kind: ReachKind, id: number) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return
    if (!(yield* reached(key, kind, id))) return yield* new NotFound({ what: kind })
  })

export const confineTopic = (topic: number) => confine('topic', topic)
export const confinePersona = (persona: number) => confine('persona', persona)

/** A chat is within a key's reach when its Topic is. */
export const confineChat = (chat: string) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return
    const topic = yield* Chats.use((chats) => chats.topicOf(chat))
    if (!(yield* reached(key, 'topic', topic))) return yield* new NotFound({ what: 'conversation' })
  })

/**
 * What a create made, recorded as the key's, and its views told that a key made it (ADR 0108); one an operation id found
 * that the key did not make is a `Conflict`, so a key can never adopt the owner's own Topic or Persona.
 */
export const claim = (kind: ReachKind, id: number, created: boolean) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return
    if (created) {
      const now = yield* epochSeconds
      const db = yield* Db
      yield* Effect.sync(() => recordReach(db, key, kind, id, now))
      return yield* (yield* Changes).publish(kind === 'topic' ? 'topics.changed' : 'personas.changed', { ids: [id] })
    }
    if (!(yield* reached(key, kind, id))) return yield* new Conflict({ reason: 'key_reach' })
  })

type Setup = Pick<TopicSetup, 'mcpServers' | 'skills' | 'apps'> & { readonly subagents?: boolean }

/** A setup under the key's ceiling: only its servers, tool by tool, never `all`, no apps and no subagents. */
const setupWithin = (key: KeyGrant, setup: Setup): boolean =>
  setup.mcpServers !== 'all' &&
  setup.mcpServers.every((server) => key.servers.includes(server.connectionId) && server.tools !== 'all') &&
  setup.skills !== 'all' &&
  setup.skills.every((skill) => key.servers.includes(skill.connectionId)) &&
  setup.apps !== 'all' &&
  setup.apps.length === 0 &&
  setup.subagents !== true

/** Items a key may add to its Topic's setup: tools, skills and skill libraries of its servers. */
const itemWithin = (key: KeyGrant, item: SetupItem): boolean =>
  (item.kind === 'tool' || item.kind === 'skill' || item.kind === 'library') && key.servers.includes(item.connectionId)

const ceiling = (within: (key: KeyGrant) => boolean) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key !== undefined && !within(key)) return yield* new Forbidden({ reason: 'key_setup' })
  })

export const confineSetup = (setup: Setup) => ceiling((key) => setupWithin(key, setup))
export const confineSetupEdit = (edit: TopicSetupEdit) =>
  ceiling((key) =>
    'set' in edit ? setupWithin(key, edit.set) : 'add' in edit ? edit.add.every((item) => itemWithin(key, item)) : true,
  )

/**
 * An MCP server a key's thread declares (ADR 0091): only on an origin the owner granted the key, and only tools of that
 * origin's list. The origin and the tools it may call, which are the declared ones or, when it names none, the whole
 * list. A request that is not a key's is refused (`key_only`), as is any other origin (`key_origin`) or tool
 * (`key_origin_tool`).
 *
 * @internal The endpoints that take a thread's servers call it; until they land, only its tests do.
 */
export const confineThreadServer = (url: string, tools: readonly string[] | undefined) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return yield* new Forbidden({ reason: 'key_only' })
    const origin = serverOriginOf(url)
    const granted = key.origins.find((each) => each.origin === origin)
    if (granted === undefined) return yield* new Forbidden({ reason: 'key_origin' })
    if (tools !== undefined && !tools.every((tool) => granted.tools.includes(tool)))
      return yield* new Forbidden({ reason: 'key_origin_tool' })
    return { origin: granted.origin, tools: tools ?? granted.tools }
  })

/** A key's change of one of its chats (ADR 0090): a title, closing or reopening; pinning a subagent open is the owner's. */
export const confineUpdate = (change: { readonly keepOpen?: boolean | undefined }) =>
  Effect.gen(function* () {
    if ((yield* requestKey) !== undefined && change.keepOpen !== undefined)
      return yield* new Forbidden({ reason: 'key_keep_open' })
  })

/** What may come with a key's message: Persona tags of its own Personas only, no files and no App context. */
export const confineMessage = (context: {
  readonly selections: readonly { readonly kind: string; readonly personaId?: number }[]
  readonly attachments: readonly unknown[]
  readonly appContext: readonly unknown[]
}) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return
    if (context.attachments.length > 0 || context.appContext.length > 0)
      return yield* new Forbidden({ reason: 'key_message' })
    for (const selection of context.selections) {
      if (selection.kind !== 'persona' || selection.personaId === undefined)
        return yield* new Forbidden({ reason: 'key_message' })
      if (!(yield* reached(key, 'persona', selection.personaId))) return yield* new NotFound({ what: 'persona' })
    }
  })

/** `read`, answered once for each id. */
const memo = <K>(read: (id: K) => boolean) => {
  const known = new Map<K, boolean>()
  return (id: K): boolean => {
    const seen = known.get(id)
    if (seen !== undefined) return seen
    const within = read(id)
    known.set(id, within)
    return within
  }
}

const inOrOut = (within: boolean): Place => (within ? 'in' : 'out')

/**
 * What of the run ledger the request's key may read (ADR 0084): the events of chats within its reach, the Topics it
 * made with their threads and Persona forks, by the chat or Topic each names. Each Pi session, chat and Topic is
 * looked up once per request. None for the owner's session, which reads everything.
 */
export const inspectReach: Effect.Effect<Reach | undefined, never, Db> = Effect.gen(function* () {
  const key = yield* requestKey
  if (key === undefined) return undefined
  const db = yield* Db
  const topic = memo((id: number) => hasReach(db, key.keyId, 'topic', id))
  const chat = memo((id: string) => {
    const row = chatRow(db, id)
    return row !== undefined && topic(row.topicId)
  })
  const session = memo((id: string) => {
    const owner = chatOfSession(db, id)
    return owner !== undefined && chat(owner)
  })
  const place = (event: RunEvent): Place => {
    if (event.conversationId !== undefined) return inOrOut(session(event.conversationId))
    const named = event.attributes[RunAttribute.chat]
    if (typeof named === 'string') return inOrOut(chat(named))
    const topicId = event.attributes[RunAttribute.topic]
    return typeof topicId === 'number' ? inOrOut(topic(topicId)) : 'nowhere'
  }
  return { place, chat }
})
