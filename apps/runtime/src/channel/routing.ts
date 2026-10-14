// Telegram routes as the owner and the agent change them (ADR 0055): the Chats list (the server's chat list merged with
// goblin's routes), a route set for one chat or topic, and what goblin does with new chats. A route change goes through
// the channel, between pulls, so what a chat held is delivered in order.
import {
  type ChannelStatus,
  type NewChatsDefault,
  type RoutePick,
  TELEGRAM_DM,
  type TelegramChat,
  type TelegramChats,
  type TelegramRoute,
} from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import { type AppError, InvalidInput, NotFound } from '../http/errors.ts'
import { Receipts } from '../organize/service.ts'
import { Personas } from '../personas/service.ts'
import { Db } from '../runtime/db.ts'
import { Topics } from '../topics/service.ts'
import {
  type RouteChoice,
  type RouteRow,
  allRoutes,
  chatRoute,
  heldCounts,
  ownRoute,
  routeRow,
  seeChat,
} from './routes.ts'
import { topicFor, topicOperation } from './places.ts'
import { Channel } from './service.ts'
import { onChannel } from './turns.ts'

/**
 * Where a row stands in the Chats list: a chat the bot is out of says so on its topics too; a topic with no route of
 * its own stands as its chat does.
 */
function standing(row: RouteRow, parent: RouteRow | undefined, own: TelegramRoute | undefined) {
  const chatStatus = parent?.status ?? row.status
  if (chatStatus === 'paused' || chatStatus === 'left') return chatStatus
  return row.thread === 0 || own !== undefined ? row.status : chatStatus
}

/** A row as the Chats list shows it, with its chat's row for a topic, and how many messages its chat holds. */
function chatView(db: DrizzleSqliteDODatabase, row: RouteRow, held: ReadonlyMap<string, number>): TelegramChat {
  const parent = row.thread === 0 ? undefined : routeRow(db, row.chat, 0)
  const own = ownRoute(row)
  const inherited = row.thread === 0 || own !== undefined ? undefined : chatRoute(db, row.chat)
  const optional = {
    ...(parent === undefined ? {} : { chatTitle: parent.title }),
    ...(row.isForum === null ? {} : { isForum: row.isForum }),
    ...(own === undefined ? {} : { route: own }),
    ...(inherited === undefined ? {} : { inherited }),
    ...(row.updatedBy === null ? {} : { updatedBy: row.updatedBy, updatedAt: row.updatedAt }),
  }
  return {
    chat: row.chat,
    thread: row.thread,
    title: row.title,
    kind: row.kind,
    status: standing(row, parent, own),
    held: row.thread === 0 ? (held.get(row.chat) ?? 0) : 0,
    offer: row.offer === 'open',
    listed: row.listed,
    revision: row.revision,
    ...optional,
  }
}

/** One chat or topic as the Chats list shows it; `NotFound` when goblin has never seen it. */
export const chatOf = (
  db: DrizzleSqliteDODatabase,
  chat: string,
  thread: number,
): Effect.Effect<TelegramChat, AppError> =>
  Effect.suspend(() => {
    const row = routeRow(db, chat, thread)
    return row === undefined
      ? Effect.fail(new NotFound({ what: 'telegram chat' }))
      : Effect.succeed(chatView(db, row, heldCounts(db)))
  })

/** Every chat and topic as the Chats list shows it, the DM first. */
export const chatsView = (
  db: DrizzleSqliteDODatabase,
  status: NonNullable<ChannelStatus>,
  synced: boolean,
): TelegramChats => {
  const held = heldCounts(db)
  return {
    reach: status.reach ?? 'dm',
    ...(status.widenUrl === undefined ? {} : { widenUrl: status.widenUrl }),
    newChats: status.newChats ?? 'ask',
    synced,
    chats: allRoutes(db).map((row) => chatView(db, row, held)),
  }
}

/** The channel while it is on; `InvalidInput` while it is off. */
const channelOn = Effect.gen(function* () {
  const status = yield* (yield* Channel).status
  if (status === null) return yield* new InvalidInput({ reason: 'telegram_off' })
  return status
})

/** The DM is always in the list, routed to Personal until the owner chooses otherwise. */
const seeDm = (db: DrizzleSqliteDODatabase, now: number) => {
  if (routeRow(db, TELEGRAM_DM, 0) === undefined)
    seeChat(db, { chat: TELEGRAM_DM, thread: 0, title: 'Telegram', kind: 'private' }, now)
}

/**
 * `GET /api/agent/channel/chats`: the server's chat list read into the routes (each chat and topic new in it offered to
 * the owner), then every chat and topic with its route.
 */
export const channelChats = Effect.gen(function* () {
  const status = yield* channelOn
  const db = yield* Db
  const now = yield* epochSeconds
  seeDm(db, now)
  // Without resident authority goblin reads no server: the list is goblin's own rows.
  const synced = yield* onChannel((channel, ports) => channel.sync(ports, now)).pipe(
    Effect.catchTag('ResidentInactive', () => Effect.succeed(Option.none<boolean>())),
  )
  return chatsView(
    db,
    (yield* (yield* Channel).status) ?? status,
    Option.getOrElse(synced, () => false),
  )
})

/** `topic` while it is active; `NotFound` otherwise. */
const activeTopic = (topic: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Topics).get(topic)
    if (found.archivedAt !== undefined) return yield* new NotFound({ what: 'topic' })
    return found.id
  })

/** `persona` while it is active; `NotFound` otherwise. */
const activePersona = (persona: number) =>
  Effect.gen(function* () {
    const active = yield* (yield* Personas).active
    if (!active.some((each) => each.id === persona)) return yield* new NotFound({ what: 'persona' })
    return persona
  })

/** A pick as the route it sets: a Topic made for "New topic", each named Topic and Persona checked active. */
export const choiceOf = (pick: RoutePick, actor: 'owner' | 'agent') =>
  Effect.gen(function* () {
    const thread = pick.thread ?? 0
    if (pick.mode === 'inherit') return { mode: 'inherit' } as const satisfies RouteChoice
    if (pick.mode === 'ignore') return { mode: 'ignore' } as const satisfies RouteChoice
    const row = routeRow(yield* Db, pick.chat, thread)
    const topic =
      pick.topic === undefined
        ? yield* topicFor(pick.newTopic ?? row?.title ?? 'Telegram', topicOperation(pick.chat, thread), actor)
        : yield* activeTopic(pick.topic)
    if (pick.mode === 'listen') return { mode: 'listen', topic } satisfies TelegramRoute
    const persona = pick.persona === undefined ? undefined : yield* activePersona(pick.persona)
    return { mode: 'answer', topic, ...(persona === undefined ? {} : { persona }) } satisfies TelegramRoute
  })

/**
 * Sets one chat's or topic's route as `actor` picked it, through the channel (its offer closes and what it held is
 * delivered). The row before and after; `NotFound` for a chat or topic goblin has never seen, `InvalidInput` while
 * the channel is off.
 */
/** Who changed a route and from where: the receipt it leaves says so (ADR 0033). */
export type RouteProvenance = {
  readonly actor: 'owner' | 'agent'
  readonly chat?: string
  readonly operationId?: string
}

/** A route in words, with its Topic's and Persona's names: what a receipt and the agent read. */
export const routeWords = (route: TelegramRoute | undefined, inherited = false) =>
  Effect.gen(function* () {
    if (route === undefined) return inherited ? 'follows its chat' : "waits for the owner's choice"
    if (route.mode === 'ignore') return 'ignored'
    const topic = yield* (yield* Topics).get(route.topic).pipe(Effect.option)
    const place = `#${Option.match(topic, { onNone: () => 'Personal', onSome: ({ name }) => name })}`
    if (route.mode === 'listen') return `kept as notes in ${place}`
    if (route.persona === undefined) return `answered by goblin in ${place}`
    const persona = yield* (yield* Personas).get(route.persona).pipe(Effect.option)
    return `answered by @${Option.match(persona, { onNone: () => 'Persona', onSome: ({ name }) => name })} in ${place}`
  })

/** A chat or topic by name, for a receipt: "Trip planning", or "Flights" in "Trip planning". */
const placeName = (db: DrizzleSqliteDODatabase, row: RouteRow) =>
  row.thread === 0 ? `"${row.title}"` : `"${row.title}" in "${routeRow(db, row.chat, 0)?.title ?? 'Telegram'}"`

/** A route as a receipt keeps it: the row's own route, none while it waits or follows its chat. */
const routeSnapshot = (row: RouteRow) => ({ route: ownRoute(row) ?? null })

/** The receipt target of a chat's or topic's route. */
const routeTarget = (row: Pick<RouteRow, 'chat' | 'thread'>) => `${row.chat}:${String(row.thread)}`

/**
 * Sets one chat's or topic's route as `by` picked it, through the channel (its offer closes and what it held is
 * delivered), and leaves an organizing receipt with Undo. The row before and after and the receipt's words; `NotFound`
 * for a chat or topic goblin has never seen, `InvalidInput` while the channel is off.
 */
export const setChatRoute = (pick: RoutePick, by: RouteProvenance) =>
  Effect.gen(function* () {
    yield* channelOn
    const db = yield* Db
    const key = { chat: pick.chat, thread: pick.thread ?? 0 }
    if (routeRow(db, key.chat, key.thread) === undefined) return yield* new NotFound({ what: 'telegram chat' })
    const choice = yield* choiceOf(pick, by.actor)
    const now = yield* epochSeconds
    const changed = yield* onChannel((channel, ports) => channel.route(ports, key, choice, by.actor, now))
    const result = Option.getOrUndefined(changed)
    if (result === undefined) return yield* new NotFound({ what: 'telegram chat' })
    const { before, after } = result
    const words = yield* routeWords(ownRoute(after), after.thread > 0)
    const summary = `Telegram ${placeName(db, after)} is ${words}`
    yield* (yield* Receipts).record({
      kind: 'telegram.route',
      target: routeTarget(after),
      summary,
      actor: by.actor,
      ...(by.chat === undefined ? {} : { chat: by.chat }),
      before: routeSnapshot(before),
      after: routeSnapshot(after),
      afterRevision: after.revision,
      ...(by.operationId === undefined ? {} : { operationId: `telegram.route:${by.operationId}` }),
    })
    return { before, after, summary }
  })

/** `PUT /api/agent/channel/routes`: the owner's route for one chat or topic, as the Chats list shows it after. */
export const routeChannel = (pick: RoutePick) =>
  Effect.gen(function* () {
    const { after } = yield* setChatRoute(pick, { actor: 'owner' })
    return yield* chatOf(yield* Db, after.chat, after.thread)
  })

const NEW_CHATS_WORDS: Record<NewChatsDefault, string> = {
  ask: 'wait for the owner to choose',
  topic: 'each get a new Topic',
  personal: 'go to Personal',
}

/**
 * What goblin does with new chats, as `by` set it, with an organizing receipt and Undo; the receipt's words.
 * `InvalidInput` while the channel is off.
 */
export const setNewChatsDefault = (newChats: NewChatsDefault, by: RouteProvenance) =>
  Effect.gen(function* () {
    const changed = yield* (yield* Channel).newChats(newChats)
    if (changed === undefined) return yield* new InvalidInput({ reason: 'telegram_off' })
    const summary = `New Telegram chats ${NEW_CHATS_WORDS[newChats]}`
    yield* (yield* Receipts).record({
      kind: 'telegram.default',
      target: 'new_chats',
      summary,
      actor: by.actor,
      ...(by.chat === undefined ? {} : { chat: by.chat }),
      before: { newChats: changed.before },
      after: { newChats },
      afterRevision: changed.revision,
      ...(by.operationId === undefined ? {} : { operationId: `telegram.default:${by.operationId}` }),
    })
    return summary
  })

/** `PUT /api/agent/channel/settings`: what goblin does with new chats; the channel's status after. */
export const channelSettings = (newChats: NewChatsDefault) =>
  Effect.gen(function* () {
    yield* setNewChatsDefault(newChats, { actor: 'owner' })
    return yield* (yield* Channel).status
  })
