import type { SetupItem, TopicSetup, TopicSetupEdit } from '@goblin/contracts'
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
import { Db } from '../runtime/db.ts'
import { type ReachKind, hasReach, madeByKey, recordReach } from './reach.ts'

/**
 * What a server's API key may do inside the agent (ADR 0081): reach only the Topics, their chats and the Personas it
 * made, and write setups under its server ceiling. Every program here does nothing for the owner's own session.
 */

/** The key the current request came with; none for the owner's session or work outside a request. */
export const requestKey: Effect.Effect<KeyGrant | undefined> = Effect.map(
  Effect.serviceOption(RequestContext),
  (context) => Option.getOrUndefined(context)?.key,
)

/**
 * Whether work in Topic `topic` is a server's (ADR 0087): it comes through a key, or a key made the Topic, whoever works
 * there. It never runs on the owner's own subscriptions.
 */
export const serverWorkIn = (db: DrizzleSqliteDODatabase, topic: number): Effect.Effect<boolean> =>
  Effect.map(requestKey, (key) => key !== undefined || madeByKey(db, 'topic', topic))

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
 * What a create made, recorded as the key's; one an operation id found that the key did not make is a `Conflict`, so a
 * key can never adopt the owner's own Topic or Persona.
 */
export const claim = (kind: ReachKind, id: number, created: boolean) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    if (key === undefined) return
    if (created) {
      const now = yield* epochSeconds
      const db = yield* Db
      return yield* Effect.sync(() => recordReach(db, key.keyId, kind, id, now))
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
