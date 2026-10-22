import {
  CONVERSATION_UPDATED,
  ConversationUpdated,
  type EventsPolled,
  type PublishedOccurrence,
} from '@goblin/contracts'
import { type SQL, and, asc, desc, eq, gt, gte, inArray, lt, lte, max, min, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { hasReach, reachedIds } from '../keys/reach.ts'
import {
  appPublishDeliveries,
  appPublishDirty,
  appPublishJournal,
  appPublishPosition,
  appPublishSubscriptions,
} from '../storage/publish.ts'
import { cursorOf, positionOf, sameWake } from './event.ts'
import { PUBLISH_LIMITS } from './policy.ts'

// The journal of the Events goblin publishes (ADR 0112) in the agent's SQLite: its position (mysi's `owner_seq`), the
// chats waiting to be looked at, an occurrence's append with its fan-out in one short transaction, a poll's page and
// pruning. Synchronous: nothing here waits on Pi or a receiver.

type Db<R = unknown> = SQLiteAsyncDatabase<'sync', R>

const ROW = 1

/** The position row, as stored or as it starts. */
const position = <R>(db: Db<R>) =>
  db.select().from(appPublishPosition).where(eq(appPublishPosition.id, ROW)).get() ?? {
    id: ROW,
    head: 0,
    floor: 0,
    polledAt: null,
  }

/** The newest occurrence's position. */
export const headOf = <R>(db: Db<R>): number => position(db).head

/** The next position, taken. */
const bump = <R>(db: Db<R>): number => {
  const [row] = db
    .insert(appPublishPosition)
    .values({ id: ROW, head: 1, floor: 0 })
    .onConflictDoUpdate({ target: appPublishPosition.id, set: { head: sql`${appPublishPosition.head} + 1` } })
    .returning({ head: appPublishPosition.head })
    .all()
  return row?.head ?? 1
}

/** Someone polled at `now`: the journal goes on for the retention from then, a lease or not. */
export const notePoll = <R>(db: Db<R>, now: number): void => {
  db.insert(appPublishPosition)
    .values({ id: ROW, head: 0, floor: 0, polledAt: now })
    .onConflictDoUpdate({ target: appPublishPosition.id, set: { polledAt: now } })
    .run()
}

/** A lease that still runs: active or failing, not past its end. */
const runningLease = (now: number) =>
  and(sql`${appPublishSubscriptions.status} IN ('active', 'failing')`, gt(appPublishSubscriptions.refreshBefore, now))

/**
 * Whether anyone listens: a lease runs, or someone polled within the journal's retention. Without either, nothing is
 * journaled; the first poll answers where now is, and the journal starts there.
 */
export const listened = <R>(db: Db<R>, now: number): boolean => {
  const lease = db
    .select({ id: appPublishSubscriptions.id })
    .from(appPublishSubscriptions)
    .where(runningLease(now))
    .limit(1)
    .get()
  return lease !== undefined || (position(db).polledAt ?? Number.NEGATIVE_INFINITY) >= now - PUBLISH_LIMITS.retentionMs
}

/** `chat` changed at `now` and waits to be looked at; one waiting already keeps its time. */
export const markDirty = <R>(db: Db<R>, chat: string, now: number): void => {
  db.insert(appPublishDirty).values({ chatId: chat, since: now }).onConflictDoNothing().run()
}

/** The chats waiting to be looked at, oldest first. */
export const dirtyChats = <R>(db: Db<R>): readonly string[] =>
  db
    .select({ chat: appPublishDirty.chatId })
    .from(appPublishDirty)
    .orderBy(asc(appPublishDirty.since))
    .all()
    .map(({ chat }) => chat)

/** `chat` was looked at. */
export const clearDirty = <R>(db: Db<R>, chat: string): void => {
  db.delete(appPublishDirty).where(eq(appPublishDirty.chatId, chat)).run()
}

const decodeWake = Schema.decodeUnknownOption(Schema.fromJsonString(ConversationUpdated))

/** A chat's wake as it was looked at: what it says, its Topic, the occurrence's id and when (epoch ms). */
export type Wake = {
  readonly data: ConversationUpdated
  readonly topicId: number
  readonly eventId: string
  readonly at: number
}

/** The key a lease's holder is (`key:<id>`), when a key holds it. */
export const keyOfHolder = (holder: string): string | undefined =>
  holder.startsWith('key:') ? holder.slice('key:'.length) : undefined

/** The occurrence a journal row is. */
const occurrenceOf = (row: typeof appPublishJournal.$inferSelect): PublishedOccurrence => ({
  eventId: row.eventId,
  name: row.name,
  timestamp: new Date(row.at).toISOString(),
  // SAFETY: the journal holds only data this module encoded from a `ConversationUpdated`.
  data: JSON.parse(row.dataJson) as ConversationUpdated,
  cursor: cursorOf(row.seq),
})

/** The wake owed to `lease` for `wake.data.chat`: the waiting one says the newest instead, else a new one waits. */
function queueWake<R>(db: Db<R>, lease: string, occurrence: PublishedOccurrence, at: number): void {
  const chat = occurrence.data.chat
  const body = JSON.stringify(occurrence)
  const seq = Number(occurrence.cursor)
  const waiting = db
    .select({ seq: appPublishDeliveries.seq })
    .from(appPublishDeliveries)
    .where(
      and(
        eq(appPublishDeliveries.subscriptionId, lease),
        eq(appPublishDeliveries.chatId, chat),
        eq(appPublishDeliveries.kind, 'occurrence'),
        sql`${appPublishDeliveries.claim} IS NULL`,
      ),
    )
    .get()
  if (waiting !== undefined) {
    db.update(appPublishDeliveries)
      .set({ journalSeq: seq, webhookId: occurrence.eventId, body })
      .where(eq(appPublishDeliveries.seq, waiting.seq))
      .run()
    return
  }
  db.insert(appPublishDeliveries)
    .values({
      subscriptionId: lease,
      kind: 'occurrence',
      chatId: chat,
      journalSeq: seq,
      webhookId: occurrence.eventId,
      body,
      firstAt: at,
      nextAt: at,
    })
    .run()
}

/** Every active lease whose selector takes the wake and whose holder reaches its chat: a key only its own rooms. */
function fanOut<R>(db: Db<R>, occurrence: PublishedOccurrence, wake: Wake): number {
  const leases = db
    .select()
    .from(appPublishSubscriptions)
    .where(
      and(
        eq(appPublishSubscriptions.status, 'active'),
        eq(appPublishSubscriptions.name, occurrence.name),
        gt(appPublishSubscriptions.refreshBefore, wake.at),
      ),
    )
    .all()
  let queued = 0
  for (const lease of leases) {
    if (lease.topicId !== null && lease.topicId !== wake.topicId) continue
    if (lease.chatId !== null && lease.chatId !== wake.data.chat) continue
    const key = keyOfHolder(lease.principal)
    if (key !== undefined && !hasReach(db, key, 'topic', wake.topicId)) continue
    queueWake(db, lease.id, occurrence, wake.at)
    queued += 1
  }
  return queued
}

/**
 * `wake` journaled and owed to every lease that takes it, in one transaction, and its chat no longer waiting; nothing
 * when it says what the chat's newest occurrence says. Its position and how many deliveries it queued.
 */
export function record(
  db: Db,
  wake: Wake,
): { readonly seq: number; readonly occurrence: PublishedOccurrence; readonly queued: number } | undefined {
  return db.transaction((tx) => {
    const chat = wake.data.chat
    const last = tx
      .select({ data: appPublishJournal.dataJson })
      .from(appPublishJournal)
      .where(eq(appPublishJournal.chatId, chat))
      .orderBy(desc(appPublishJournal.seq))
      .limit(1)
      .get()
    const before = last === undefined ? Option.none() : decodeWake(last.data)
    if (Option.isSome(before) && sameWake(before.value, wake.data)) {
      clearDirty(tx, chat)
      return undefined
    }
    const seq = bump(tx)
    const occurrence: PublishedOccurrence = {
      eventId: wake.eventId,
      name: CONVERSATION_UPDATED,
      timestamp: new Date(wake.at).toISOString(),
      data: wake.data,
      cursor: cursorOf(seq),
    }
    tx.insert(appPublishJournal)
      .values({
        seq,
        eventId: wake.eventId,
        name: CONVERSATION_UPDATED,
        chatId: chat,
        topicId: wake.topicId,
        dataJson: JSON.stringify(wake.data),
        at: wake.at,
      })
      .run()
    const queued = fanOut(tx, occurrence, wake)
    clearDirty(tx, chat)
    return { seq, occurrence, queued }
  })
}

/** A poll as the journal reads it: its holder's key (none reaches every chat), its selector, cursor and bounds. */
export type PageQuery = {
  readonly key: string | undefined
  readonly name: string
  readonly topicId?: number | undefined
  readonly chat?: string | undefined
  readonly cursor: string | null
  readonly maxEvents: number
  /** Occurrences before this (epoch ms) are too old for the poll. */
  readonly cutoff: number
}

/**
 * The occurrences after `query.cursor` the poll's holder reaches and its selector takes, oldest first, at most
 * `maxEvents`: none from a `null` cursor, which answers where the journal is now. `truncated` when some after the
 * cursor are pruned or too old.
 */
export function page(db: Db, query: PageQuery): EventsPolled {
  const { head, floor } = position(db)
  const from = query.cursor === null ? head : positionOf(query.cursor, head)
  const conditions: SQL[] = [
    gt(appPublishJournal.seq, from),
    lte(appPublishJournal.seq, head),
    eq(appPublishJournal.name, query.name),
  ]
  if (query.topicId !== undefined) conditions.push(eq(appPublishJournal.topicId, query.topicId))
  if (query.chat !== undefined) conditions.push(eq(appPublishJournal.chatId, query.chat))
  if (query.key !== undefined) conditions.push(inArray(appPublishJournal.topicId, reachedIds(db, query.key, 'topic')))
  const rows = db
    .select()
    .from(appPublishJournal)
    .where(and(...conditions, gte(appPublishJournal.at, query.cutoff)))
    .orderBy(asc(appPublishJournal.seq))
    .limit(query.maxEvents + 1)
    .all()
  const older =
    query.cursor !== null &&
    db
      .select({ seq: appPublishJournal.seq })
      .from(appPublishJournal)
      .where(and(...conditions, lt(appPublishJournal.at, query.cutoff)))
      .limit(1)
      .get() !== undefined
  const events = rows.slice(0, query.maxEvents)
  const hasMore = rows.length > query.maxEvents
  const last = events.at(-1)
  return {
    events: events.map(occurrenceOf),
    cursor: cursorOf(hasMore && last !== undefined ? last.seq : head),
    truncated: query.cursor !== null && (from < floor || older),
    hasMore,
    nextPollMs: PUBLISH_LIMITS.nextPollMs,
  }
}

/** Whether a cursor sent with a subscribe is past what the journal keeps. */
export const behind = <R>(db: Db<R>, cursor: string | null | undefined): boolean => {
  if (cursor === null || cursor === undefined) return false
  const { head, floor } = position(db)
  return positionOf(cursor, head) < floor
}

/** Occurrences past the journal's retention go, and the floor moves past them. */
export function pruneJournal(db: Db, now: number): void {
  db.transaction((tx) => {
    const cutoff = now - PUBLISH_LIMITS.retentionMs
    const gone = tx
      .select({ seq: max(appPublishJournal.seq) })
      .from(appPublishJournal)
      .where(lt(appPublishJournal.at, cutoff))
      .get()?.seq
    if (gone === null || gone === undefined) return
    tx.delete(appPublishJournal).where(lte(appPublishJournal.seq, gone)).run()
    tx.update(appPublishPosition)
      .set({ floor: sql`max(${appPublishPosition.floor}, ${gone})` })
      .where(eq(appPublishPosition.id, ROW))
      .run()
  })
}

/** When the oldest occurrence passes the retention, if there is one. */
export const nextPrune = <R>(db: Db<R>): number | undefined => {
  const oldest = db
    .select({ at: min(appPublishJournal.at) })
    .from(appPublishJournal)
    .get()?.at
  return oldest === null || oldest === undefined ? undefined : oldest + PUBLISH_LIMITS.retentionMs
}
