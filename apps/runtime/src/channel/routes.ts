// Where each Telegram chat and forum topic goes (ADR 0055): the rows of `app_telegram_routes` and the messages
// `app_telegram_held` keeps while a chat waits for the owner's choice. Plain functions over the agent's SQLite; each
// write is one statement or one short transaction, never across a network call.
import {
  PERSONAL_TOPIC,
  TELEGRAM_DM,
  type TelegramChatKind,
  type TelegramChatStatus,
  type TelegramRoute,
} from '@goblin/contracts'
import { and, asc, count, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appTelegramHeld, appTelegramRoutes } from '../storage/telegram.ts'

type Db = DrizzleSqliteDODatabase

/** One chat's or forum topic's row. */
export type RouteRow = typeof appTelegramRoutes.$inferSelect

/** What happens to a message now: its route, or `hold` while its chat waits for the owner's choice. */
export type Effective = TelegramRoute | { readonly mode: 'hold' }

/** A route as the owner or the agent sets it, or `inherit`: a forum topic follows its chat. */
export type RouteChoice = TelegramRoute | { readonly mode: 'inherit' }

/** How many messages a waiting chat keeps; older ones are dropped and counted. */
export const HELD_LIMIT = 20

/** The DM's own route when the owner never chose one: Personal, answered by goblin. */
const DM_ROUTE: TelegramRoute = { mode: 'answer', topic: PERSONAL_TOPIC }

/** The row of `chat`'s `thread` (0 is the chat itself). */
export const routeRow = (db: Db, chat: string, thread: number): RouteRow | undefined =>
  db
    .select()
    .from(appTelegramRoutes)
    .where(and(eq(appTelegramRoutes.chat, chat), eq(appTelegramRoutes.thread, thread)))
    .get()

/** A row's own route, or none (pending, or a topic that follows its chat). */
export function ownRoute(row: Pick<RouteRow, 'mode' | 'topicId' | 'personaId'>): TelegramRoute | undefined {
  if (row.mode === 'ignore') return { mode: 'ignore' }
  if (row.topicId === null) return undefined
  if (row.mode === 'listen') return { mode: 'listen', topic: row.topicId }
  if (row.mode === 'answer')
    return row.personaId === null
      ? { mode: 'answer', topic: row.topicId }
      : { mode: 'answer', topic: row.topicId, persona: row.personaId }
  return undefined
}

/** The route `chat` itself has: its own, the DM's default, or none while it waits for the owner. */
export function chatRoute(db: Db, chat: string): TelegramRoute | undefined {
  const row = routeRow(db, chat, 0)
  const own = row === undefined ? undefined : ownRoute(row)
  return own ?? (chat === TELEGRAM_DM ? DM_ROUTE : undefined)
}

/** What happens to a message of `chat`'s `thread` now: the topic's own route, else its chat's, else it waits. */
export function effectiveRoute(db: Db, chat: string, thread: number): Effective {
  const row = thread === 0 ? undefined : routeRow(db, chat, thread)
  const own = row === undefined ? undefined : ownRoute(row)
  return own ?? chatRoute(db, chat) ?? { mode: 'hold' }
}

/** What goblin knows of a chat or topic when it sees it: its title, kind and forum flag. */
export type Seen = {
  readonly chat: string
  readonly thread: number
  readonly title: string
  readonly kind: TelegramChatKind
  readonly isForum?: boolean
}

/**
 * Records `seen`: a new chat waits for the owner (the DM is routed to Personal from the start), a new topic follows its
 * chat; a known one takes the new title, kind and forum flag and is listed again. Whether it was new.
 */
export function seeChat(db: Db, seen: Seen, now: number): { readonly row: RouteRow; readonly created: boolean } {
  const known = routeRow(db, seen.chat, seen.thread)
  const facts = {
    title: seen.title.slice(0, 200),
    kind: seen.kind,
    ...(seen.isForum === undefined ? {} : { isForum: seen.isForum }),
  }
  if (known !== undefined) {
    db.update(appTelegramRoutes)
      .set({ ...facts, listed: true, updatedAt: now })
      .where(and(eq(appTelegramRoutes.chat, seen.chat), eq(appTelegramRoutes.thread, seen.thread)))
      .run()
    return { row: routeRow(db, seen.chat, seen.thread) ?? known, created: false }
  }
  const dm = seen.chat === TELEGRAM_DM && seen.thread === 0
  db.insert(appTelegramRoutes)
    .values({
      chat: seen.chat,
      thread: seen.thread,
      ...facts,
      status: seen.thread === 0 && !dm ? 'pending' : 'routed',
      ...(dm ? { mode: 'answer' as const, topicId: PERSONAL_TOPIC } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run()
  const row = routeRow(db, seen.chat, seen.thread)
  return row === undefined ? { row: { ...emptyRow(seen, now) }, created: false } : { row, created: true }
}

/** A row as `seeChat` would write it, for the read that cannot miss it. */
const emptyRow = (seen: Seen, now: number): RouteRow => ({
  chat: seen.chat,
  thread: seen.thread,
  title: seen.title,
  kind: seen.kind,
  isForum: seen.isForum ?? null,
  status: 'pending',
  mode: null,
  topicId: null,
  personaId: null,
  questionId: null,
  offer: null,
  heldDropped: 0,
  listed: true,
  revision: 0,
  updatedBy: null,
  createdAt: now,
  updatedAt: now,
})

/** The status a chat has when it is in the chat again: routed with a route of its own, else pending. */
const presentStatus = (row: Pick<RouteRow, 'thread' | 'mode'>): TelegramChatStatus =>
  row.thread > 0 || row.mode !== null ? 'routed' : 'pending'

/**
 * Sets `chat`'s `thread` to `choice` (`inherit` clears a topic's own route), as `by` chose it at `now`: the revision
 * moves on and its offer closes. A chat the bot is out of keeps its status. The row before and after; none when there
 * is no such row.
 */
export function setRoute(
  db: Db,
  key: { readonly chat: string; readonly thread: number },
  choice: RouteChoice,
  by: 'owner' | 'agent',
  now: number,
): { readonly before: RouteRow; readonly after: RouteRow } | undefined {
  return db.transaction(() => {
    const before = routeRow(db, key.chat, key.thread)
    if (before === undefined) return undefined
    const route =
      choice.mode === 'inherit'
        ? { mode: null, topicId: null, personaId: null }
        : choice.mode === 'ignore'
          ? { mode: 'ignore' as const, topicId: null, personaId: null }
          : {
              mode: choice.mode,
              topicId: choice.topic,
              personaId: choice.mode === 'answer' ? (choice.persona ?? null) : null,
            }
    const lifecycle = before.status === 'paused' || before.status === 'left'
    db.update(appTelegramRoutes)
      .set({
        ...route,
        status: lifecycle ? before.status : presentStatus({ thread: key.thread, mode: route.mode }),
        offer: before.offer === null ? null : 'closed',
        revision: before.revision + 1,
        updatedBy: by,
        updatedAt: now,
      })
      .where(and(eq(appTelegramRoutes.chat, key.chat), eq(appTelegramRoutes.thread, key.thread)))
      .run()
    const after = routeRow(db, key.chat, key.thread)
    return after === undefined ? undefined : { before, after }
  })
}

/** The bot is out of `chat` (`paused`, `left`) or in it again (`active`): its own row's status follows. */
export function setPresence(db: Db, chat: string, presence: 'active' | 'paused' | 'left', now: number): void {
  const row = routeRow(db, chat, 0)
  if (row === undefined) return
  const status = presence === 'active' ? presentStatus(row) : presence
  if (status === row.status) return
  db.update(appTelegramRoutes)
    .set({ status, updatedAt: now })
    .where(and(eq(appTelegramRoutes.chat, chat), eq(appTelegramRoutes.thread, 0)))
    .run()
}

/** Remembers goblin's question `questionId` about `chat`'s `thread`, open until it is answered. */
export function openOffer(db: Db, key: { readonly chat: string; readonly thread: number }, questionId: string): void {
  db.update(appTelegramRoutes)
    .set({ questionId, offer: 'open' })
    .where(and(eq(appTelegramRoutes.chat, key.chat), eq(appTelegramRoutes.thread, key.thread)))
    .run()
}

/** Closes the offer about `chat`'s `thread`, answered or not. */
export function closeOffer(db: Db, key: { readonly chat: string; readonly thread: number }): void {
  db.update(appTelegramRoutes)
    .set({ offer: 'closed' })
    .where(
      and(
        eq(appTelegramRoutes.chat, key.chat),
        eq(appTelegramRoutes.thread, key.thread),
        eq(appTelegramRoutes.offer, 'open'),
      ),
    )
    .run()
}

/** The row goblin's question `questionId` was about, open or closed. */
export const offerOf = (db: Db, questionId: string): RouteRow | undefined =>
  db.select().from(appTelegramRoutes).where(eq(appTelegramRoutes.questionId, questionId)).get()

/** Every row, chats before their topics, the DM first. */
export const allRoutes = (db: Db): readonly RouteRow[] =>
  db
    .select()
    .from(appTelegramRoutes)
    .orderBy(
      sql`${appTelegramRoutes.chat} <> ${TELEGRAM_DM}`,
      asc(appTelegramRoutes.chat),
      asc(appTelegramRoutes.thread),
    )
    .all()

/** The chats the server lists now are `listed`; every other chat is not, and keeps its route. */
export function markListed(db: Db, chats: readonly string[]): void {
  db.transaction(() => {
    if (chats.length > 0)
      db.update(appTelegramRoutes)
        .set({ listed: true })
        .where(inArray(appTelegramRoutes.chat, [...chats]))
        .run()
    db.update(appTelegramRoutes)
      .set({ listed: false })
      .where(chats.length === 0 ? undefined : notInArray(appTelegramRoutes.chat, [...chats]))
      .run()
  })
}

/** One message held for a waiting chat: mygram's entry id, its topic, its words and how it reached the bot. */
export type Held = {
  readonly entryId: string
  readonly chat: string
  readonly thread: number
  readonly text: string
  readonly trigger: string | null
}

/**
 * Holds `held` until its chat has a route: the twenty newest of a chat are kept, and each one dropped past them is
 * counted on the chat's row. Holding the same entry again changes nothing.
 */
export function hold(db: Db, held: Held, now: number): void {
  db.transaction(() => {
    db.insert(appTelegramHeld)
      .values({ ...held, heldAt: now })
      .onConflictDoNothing()
      .run()
    const kept = db
      .select({ entryId: appTelegramHeld.entryId })
      .from(appTelegramHeld)
      .where(eq(appTelegramHeld.chat, held.chat))
      .orderBy(sql`rowid DESC`)
      .all()
    const dropped = kept.slice(HELD_LIMIT).map(({ entryId }) => entryId)
    if (dropped.length === 0) return
    db.delete(appTelegramHeld).where(inArray(appTelegramHeld.entryId, dropped)).run()
    db.update(appTelegramRoutes)
      .set({ heldDropped: sql`${appTelegramRoutes.heldDropped} + ${dropped.length}` })
      .where(and(eq(appTelegramRoutes.chat, held.chat), eq(appTelegramRoutes.thread, 0)))
      .run()
  })
}

/** What `chat` holds, oldest first. */
export const heldOf = (db: Db, chat: string): readonly Held[] =>
  db
    .select({
      entryId: appTelegramHeld.entryId,
      chat: appTelegramHeld.chat,
      thread: appTelegramHeld.thread,
      text: appTelegramHeld.text,
      trigger: appTelegramHeld.trigger,
    })
    .from(appTelegramHeld)
    .where(eq(appTelegramHeld.chat, chat))
    .orderBy(sql`rowid`)
    .all()

/** How many messages each chat holds. */
export function heldCounts(db: Db): ReadonlyMap<string, number> {
  const rows = db
    .select({ chat: appTelegramHeld.chat, held: count() })
    .from(appTelegramHeld)
    .groupBy(appTelegramHeld.chat)
    .all()
  return new Map(rows.map(({ chat, held }) => [chat, held]))
}

/** A held message went on to its route. */
export function release(db: Db, entryId: string): void {
  db.delete(appTelegramHeld).where(eq(appTelegramHeld.entryId, entryId)).run()
}

/** How many held messages of `chat` were dropped past the twenty kept, now told: the count starts again. */
export function takeDropped(db: Db, chat: string): number {
  return db.transaction(() => {
    const dropped = routeRow(db, chat, 0)?.heldDropped ?? 0
    if (dropped > 0)
      db.update(appTelegramRoutes)
        .set({ heldDropped: 0 })
        .where(and(eq(appTelegramRoutes.chat, chat), eq(appTelegramRoutes.thread, 0)))
        .run()
    return dropped
  })
}

/**
 * Drops every held message and closes every open offer: the channel was turned off. The routes stay, so turning it on
 * again finds the owner's choices.
 */
export function dropHeld(db: Db): void {
  db.transaction(() => {
    db.delete(appTelegramHeld).run()
    db.update(appTelegramRoutes).set({ offer: 'closed' }).where(eq(appTelegramRoutes.offer, 'open')).run()
    db.update(appTelegramRoutes).set({ heldDropped: 0 }).run()
  })
}
