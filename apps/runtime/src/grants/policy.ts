import {
  type Need,
  type SetupItem,
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
import { chatOfSession, chatRow } from '../chats/directory.ts'
import { epochSeconds } from '../clock.ts'
import { RequestContext } from '../http/api/context.ts'
import type { Credential } from '../http/api/principal.ts'
import { Forbidden, NotFound, attemptSync } from '../http/errors.ts'
import type { Place, Reach } from '../inspect/service.ts'
import { recordMaker } from '../keys/made-by.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { mirrorReaches } from './mirror.ts'
import { type TurnPower, senderOf, senderPower } from './power.ts'
import { Grants } from './service.ts'

/**
 * What a credential may do inside the agent (ADR 0114): a server's API key or an OAuth client acting for a person
 * reaches what its grant reaches (`Grants`), never more; a client also no more than its person's role. Every program
 * here does nothing for a member's own session, whose role decides.
 */

/** The request's credential (ADRs 0086, 0114); none for a member's session or work outside a request. */
export const requestCredential: Effect.Effect<Credential | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => Option.getOrUndefined(context)?.credential,
)

/**
 * The key the current request came with: its work is a server's (ADR 0087), on the deployment's models. None for a
 * member's session, an OAuth client acting for a person or work outside a request.
 */
export const requestKey: Effect.Effect<Credential | undefined> = Effect.map(requestCredential, (credential) =>
  credential?.kind === 'key' ? credential : undefined,
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
 * a member's request, from their browser or a client acting for them, is `Forbidden` `role`. Anything no member sent
 * passes; a credential's own grant bounds it (`requireAccessFor`).
 */
export const requireAdminFor = (configures: boolean): Effect.Effect<void, Forbidden> =>
  configures
    ? Effect.flatMap(requestRole, (role) =>
        role === 'member' ? Effect.fail(new Forbidden({ reason: 'role' })) : Effect.void,
      )
    : Effect.void

/**
 * What a call takes beyond its endpoint's own need (ADR 0114): `need` of a credential's grant (`AccessInsufficient`
 * otherwise), and, when it `configures` the agent, an owner or admin person (`requireAdminFor`), for a client acting
 * for one as for their browser.
 */
export const requireAccessFor = (need: Partial<Need> | undefined, configures: boolean) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential !== undefined && need !== undefined) yield* Grants.use((grants) => grants.require(credential, need))
    yield* requireAdminFor(configures)
  })

/**
 * Where a request's flow comes from (ADR 0037): a credential's (ADR 0086: an OAuth client or a server's key) is an MCP
 * client's, anyone else's the owner's in the app.
 */
export const requestFlowOrigin: Effect.Effect<{ readonly via: 'app' | 'mcp'; readonly actor: 'owner' | 'client' }> =
  Effect.map(requestCredential, (credential) =>
    credential === undefined ? ({ via: 'app', actor: 'owner' } as const) : ({ via: 'mcp', actor: 'client' } as const),
  )

/**
 * Who a request's message is by, which its content carries first: a server's key by its name (ADR 0115), an OAuth
 * client by the name it registered (ADR 0086, and for whom in a workspace of several people), or in such a workspace a
 * member by name and ID (ADR 0094); none for a member alone in their workspace, or any other request.
 */
export const requestAuthor: Effect.Effect<string | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => {
    const facts = Option.getOrUndefined(context)
    const member = facts?.member
    const credential = facts?.credential
    if (credential?.kind === 'key') return serverAuthor(credential.name)
    if (credential?.kind === 'client')
      return clientAuthor(credential.name, member?.shared === true ? member.name : undefined)
    if (credential === undefined && member?.shared === true) return memberAuthor(member.name, member.user)
    return undefined
  },
)

/**
 * What the current request's sender may do in a turn its input starts or joins (ADR 0115): a person's role, an OAuth
 * client's grant within its person's role, a server key's grant. None for work outside a request, which is an
 * admin's (`AUTOMATION`).
 */
export const requestPower: Effect.Effect<TurnPower | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => {
    const facts = Option.getOrUndefined(context)
    const sender = facts === undefined ? undefined : senderOf(facts)
    return sender === undefined ? undefined : senderPower(sender)
  },
)

/** A Topic a key's create makes when its body names no setup: nothing but its own chats. */
export const KEY_TOPIC_SETUP: TopicSetup = { mcpServers: [], skills: [], apps: [], subagents: false }

/** What a reach check names: a Topic, a Persona or a connection, by its id. */
type Kind = 'topic' | 'persona' | 'connection'

/**
 * The request's credential must reach the `kind` with `id` (ADR 0114): else `AccessInsufficient`, naming it as a reach
 * id with the widening link. Nothing for a member's session.
 */
export const reaches = (kind: Kind, id: number | string) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential === undefined) return
    yield* Grants.use((grants) => grants.require(credential, { reach: { kind, id: String(id) } }))
  })

export const reachesTopic = (topic: number) => reaches('topic', topic)
export const reachesPersona = (persona: number) => reaches('persona', persona)

/** A chat is within a credential's reach when its Topic is; a chat the agent does not keep is `NotFound`. */
export const reachesChat = (chat: string) =>
  Effect.gen(function* () {
    if ((yield* requestCredential) === undefined) return
    const row = yield* Db.useSync((db) => chatRow(db, chat))
    if (row === undefined) return yield* new NotFound({ what: 'conversation' })
    yield* reaches('topic', row.topicId)
  })

/**
 * What a credential's create made (ADR 0114): within its reach from then on, listed when its reach of that kind is a
 * list, and a key's recorded as made by it for its views (ADR 0115). A replay (`created` false) of a create must find
 * something it reaches: a grant that listed it on its first try, or one that reaches all; else `AccessInsufficient`,
 * so an operation id never adopts something outside its reach. A replay lists it again in the auth store, in case its
 * first try failed between the mirror and the store.
 */
export const claim = (kind: 'topic' | 'persona', id: number, created: boolean) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential === undefined) return
    const grants = yield* Grants
    const item = { kind, id: String(id) }
    if (!created) {
      yield* grants.require(credential, { reach: item })
      return yield* grants.append(credential, item)
    }
    yield* grants.append(credential, item)
    if (credential.kind !== 'key') return
    const now = yield* epochSeconds
    const db = yield* Db
    yield* attemptSync(() => recordMaker(db, { keyId: credential.id, name: credential.name }, kind, id, now))
    yield* (yield* Changes).publish(kind === 'topic' ? 'topics.changed' : 'personas.changed', { ids: [id] })
  })

/**
 * A connection a credential added (ADR 0117): within its reach from then on, listed when its reach of connections is a
 * list. Nothing for a member's session.
 */
export const claimConnection = (connectionId: string) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential === undefined) return
    yield* Grants.use((grants) => grants.append(credential, { kind: 'connection', id: connectionId }))
  })

/**
 * The items of a workspace's connections a request's credential reaches (ADR 0117): every one for a member's session
 * or a grant that reaches all of them, else those its list names.
 */
export const withinConnections = <A extends { readonly connectionId: string }>(items: readonly A[]) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential === undefined) return items
    const grants = yield* Grants
    return yield* Effect.filter(items, (item) =>
      grants.reaches(credential, { kind: 'connection', id: item.connectionId }),
    )
  })

type Setup = Pick<TopicSetup, 'mcpServers' | 'skills' | 'apps'> & { readonly subagents?: boolean }

/**
 * Whether a setup gives anything: a server, a skill, an app or subagents. Only such a setup takes a credential's
 * `setup` extra (ADR 0114); the empty one a key's create gets anyway takes none.
 */
export const namesAnything = (setup: Setup | undefined): boolean =>
  setup !== undefined &&
  (setup.mcpServers === 'all' ||
    setup.mcpServers.length > 0 ||
    setup.skills === 'all' ||
    setup.skills.length > 0 ||
    setup.apps === 'all' ||
    setup.apps.length > 0 ||
    setup.subagents === true)

/**
 * A setup a credential may write (ADR 0114): with every connection in reach, anything; with a list, only listed
 * connections and skills of them, never `all` servers or skills, and no apps or subagents, which reach beyond them.
 */
const setupWithin = (within: (connection: string) => boolean, setup: Setup): boolean =>
  setup.mcpServers !== 'all' &&
  setup.mcpServers.every((server) => within(server.connectionId)) &&
  setup.skills !== 'all' &&
  setup.skills.every((skill) => within(skill.connectionId)) &&
  setup.apps !== 'all' &&
  setup.apps.length === 0 &&
  setup.subagents !== true

/** Items a credential with a list of connections may add to a setup: tools, skills and libraries of listed ones. */
const itemWithin = (within: (connection: string) => boolean, item: SetupItem): boolean =>
  (item.kind === 'tool' || item.kind === 'skill' || item.kind === 'library') && within(item.connectionId)

/** The connections the request's credential reaches, as `setupWithin` reads them; none for a member's session. */
const connectionReach = Effect.gen(function* () {
  const credential = yield* requestCredential
  if (credential === undefined) return undefined
  const db = yield* Db
  return {
    credential,
    all: credential.ws.connections === 'all',
    within: (connection: string) => mirrorReaches(db, credential.grantId, 'connection', connection),
  }
})

/** The first connection a setup names that its credential does not reach, as a widening asks for it. */
const outsideOf = (within: (connection: string) => boolean, setup: Setup): string | undefined => {
  const named = [
    ...(setup.mcpServers === 'all' ? [] : setup.mcpServers.map((server) => server.connectionId)),
    ...(setup.skills === 'all' ? [] : setup.skills.map((skill) => skill.connectionId)),
  ]
  return named.find((connection) => !within(connection))
}

/**
 * A credential's setup within its connections (ADR 0114): a connection outside its list is `AccessInsufficient` for
 * it, and anything else past it (`all`, apps, subagents) `Forbidden` `setup_reach`.
 */
const confine = (allowed: (within: (connection: string) => boolean) => boolean, setup: Setup | undefined) =>
  Effect.gen(function* () {
    const reach = yield* connectionReach
    if (reach === undefined || reach.all || allowed(reach.within)) return
    const outside = setup === undefined ? undefined : outsideOf(reach.within, setup)
    if (outside !== undefined) return yield* reaches('connection', outside)
    return yield* new Forbidden({ reason: 'setup_reach' })
  })

export const confineSetup = (setup: Setup) => confine((within) => setupWithin(within, setup), setup)
export const confineSetupEdit = (edit: TopicSetupEdit) =>
  confine(
    (within) =>
      'set' in edit
        ? setupWithin(within, edit.set)
        : 'add' in edit
          ? edit.add.every((item) => itemWithin(within, item))
          : true,
    'set' in edit ? edit.set : undefined,
  )

/**
 * An MCP server a credential's thread declares (ADR 0091): only on an origin its grant names, and only tools of that
 * origin's list. The origin and the tools it may call, which are the declared ones or, when it names none, the whole
 * list. A request that is no credential's is refused (`credential_only`), as is any other origin (`key_origin`) or tool
 * (`key_origin_tool`).
 */
export const confineThreadServer = (url: string, tools: readonly string[] | undefined) =>
  Effect.gen(function* () {
    const credential = yield* requestCredential
    if (credential === undefined) return yield* new Forbidden({ reason: 'credential_only' })
    const origin = serverOriginOf(url)
    const granted = credential.origins.find((each) => each.origin === origin)
    if (granted === undefined) return yield* new Forbidden({ reason: 'key_origin' })
    if (tools !== undefined && !tools.every((tool) => granted.tools.includes(tool)))
      return yield* new Forbidden({ reason: 'key_origin_tool' })
    return { origin: granted.origin, tools: tools ?? granted.tools }
  })

/** A credential's change of a chat (ADR 0090): a title, closing or reopening; pinning a subagent open is a person's. */
export const confineUpdate = (change: { readonly keepOpen?: boolean | undefined }) =>
  Effect.gen(function* () {
    if ((yield* requestCredential) !== undefined && change.keepOpen !== undefined)
      return yield* new Forbidden({ reason: 'credential_keep_open' })
  })

/** What may come with a credential's message: tags of Personas it reaches only, no files and no App context. */
export const confineMessage = (context: {
  readonly selections: readonly { readonly kind: string; readonly personaId?: number }[]
  readonly attachments: readonly unknown[]
  readonly appContext: readonly unknown[]
}) =>
  Effect.gen(function* () {
    if ((yield* requestCredential) === undefined) return
    if (context.attachments.length > 0 || context.appContext.length > 0)
      return yield* new Forbidden({ reason: 'credential_message' })
    for (const selection of context.selections) {
      if (selection.kind !== 'persona' || selection.personaId === undefined)
        return yield* new Forbidden({ reason: 'credential_message' })
      yield* reachesPersona(selection.personaId)
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
 * What of the run ledger the request's credential may read (ADRs 0084, 0114): the events of chats in the Topics its
 * grant reaches, with their threads and Persona forks, by the chat or Topic each names. Each Pi session, chat and Topic
 * is looked up once per request. None for a member's session, or a credential that reaches every Topic, which read
 * everything.
 */
export const inspectReach: Effect.Effect<Reach | undefined, never, Db> = Effect.gen(function* () {
  const credential = yield* requestCredential
  if (credential === undefined || credential.ws.topics === 'all') return undefined
  const db = yield* Db
  const topic = memo((id: number) => mirrorReaches(db, credential.grantId, 'topic', String(id)))
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

/**
 * The grant whose list a page of `kind` keeps to (ADR 0114): the request's credential's, when its reach of that kind is
 * a list; none for a member's session or a credential that reaches all.
 */
export const listedBy = (kind: 'topics' | 'personas'): Effect.Effect<string | undefined> =>
  Effect.map(requestCredential, (credential) =>
    credential === undefined || credential.ws[kind] === 'all' ? undefined : credential.grantId,
  )
