import { type SQL, and, asc, eq, gt, inArray, lte, min, ne, or, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appPublishDeliveries, appPublishSubscriptions } from '../storage/publish.ts'
import { cursorOf } from './event.ts'
import type { CallbackReason, RetryDecision } from './policy.ts'

// The leases integrators hold on the Events goblin publishes (ADR 0112), and the deliveries owed to them, in the
// agent's SQLite: each change one short transaction; a delivery is claimed before it is sent and settled under its
// claim after, so no transaction spans a send and a lapsed claim's late answer changes nothing.

type Db<R = unknown> = SQLiteAsyncDatabase<'sync', R>

export type Lease = typeof appPublishSubscriptions.$inferSelect
export type Delivery = typeof appPublishDeliveries.$inferSelect

/** How long a drain's claim on a delivery lasts: longer than one send. */
const CLAIM_MS = 30_000

/** A lease by its id. */
export const leaseOf = <R>(db: Db<R>, id: string): Lease | undefined =>
  db.select().from(appPublishSubscriptions).where(eq(appPublishSubscriptions.id, id)).get()

const running = (now: number) =>
  and(ne(appPublishSubscriptions.status, 'terminated'), gt(appPublishSubscriptions.refreshBefore, now))

/** How many leases run now, other than `except`: the holder's and the workspace's. */
export function leaseCounts<R>(db: Db<R>, holder: string, now: number, except: string) {
  const count = (where: SQL | undefined) =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(appPublishSubscriptions)
      .where(and(running(now), ne(appPublishSubscriptions.id, except), where))
      .get()?.count ?? 0
  return { holder: count(eq(appPublishSubscriptions.principal, holder)), workspace: count(undefined) }
}

/**
 * `lease` as it now is: made, renewed, or made again after it ended, when what its end still owed (its `terminated`
 * control) is dropped first, so delivering it cannot take the new lease with it.
 */
export function renewLease(db: Db, lease: Lease): void {
  const { id: _id, createdAt: _created, ...renewed } = lease
  db.transaction((tx) => {
    const ended = leaseOf(tx, lease.id)?.status === 'terminated'
    if (ended) tx.delete(appPublishDeliveries).where(eq(appPublishDeliveries.subscriptionId, lease.id)).run()
    tx.insert(appPublishSubscriptions)
      .values(lease)
      .onConflictDoUpdate({ target: appPublishSubscriptions.id, set: renewed })
      .run()
  })
}

/** The lease and every delivery owed to it are gone. */
export function dropLease(db: Db, id: string): void {
  db.transaction((tx) => {
    tx.delete(appPublishDeliveries).where(eq(appPublishDeliveries.subscriptionId, id)).run()
    tx.delete(appPublishSubscriptions).where(eq(appPublishSubscriptions.id, id)).run()
  })
}

/** A control's `webhook-id`: `msg_<type>_<random>`, as the profile names them. */
const controlId = (type: string): string => `msg_${type}_${crypto.randomUUID()}`

/** Why a lease ended, as its `terminated` control says: its holder's access ended, or its lease ran out. */
export type Ending = 'revoked' | 'expired'
const ENDINGS: Readonly<Record<Ending, { readonly code: number; readonly message: string }>> = {
  revoked: { code: -32012, message: 'Access ended' },
  expired: { code: -32011, message: 'Lease expired' },
}

/** Every lease `where` picks ends: what it was owed is dropped and one `terminated` control goes to it. How many. */
function endLeases<R>(db: Db<R>, where: SQL | undefined, ending: Ending, now: number): number {
  const ended = db
    .update(appPublishSubscriptions)
    .set({ status: 'terminated', updatedAt: now })
    .where(and(ne(appPublishSubscriptions.status, 'terminated'), where))
    .returning({ id: appPublishSubscriptions.id })
    .all()
  if (ended.length === 0) return 0
  const ids = ended.map(({ id }) => id)
  db.delete(appPublishDeliveries).where(inArray(appPublishDeliveries.subscriptionId, ids)).run()
  const body = JSON.stringify({ type: 'terminated', error: ENDINGS[ending] })
  db.insert(appPublishDeliveries)
    .values(
      ids.map((id) => ({
        subscriptionId: id,
        kind: 'terminated' as const,
        webhookId: controlId('terminated'),
        body,
        firstAt: now,
        nextAt: now,
      })),
    )
    .run()
  return ended.length
}

/** Every lease `holder` holds ends, its access gone (a key revoked, rotated or losing `conversations`; a client revoked). */
export const endHolder = (db: Db, holder: string, now: number): number =>
  db.transaction((tx) => endLeases(tx, eq(appPublishSubscriptions.principal, holder), 'revoked', now))

/** Every lease not renewed before its end ends. */
export const endExpired = (db: Db, now: number): number =>
  db.transaction((tx) => endLeases(tx, lte(appPublishSubscriptions.refreshBefore, now), 'expired', now))

/** A delivery claimed for one send, with where it goes and the sealed secret it is signed with. */
export type Claimed = Delivery & { readonly url: string; readonly secret: string }

/** A delivery a drain may take: due, unclaimed or its claim lapsed, and its lease not ended unless it says so. */
const takeable = (now: number) =>
  and(
    lte(appPublishDeliveries.nextAt, now),
    or(sql`${appPublishDeliveries.claim} IS NULL`, lte(appPublishDeliveries.claimedUntil, now)),
    or(ne(appPublishSubscriptions.status, 'terminated'), eq(appPublishDeliveries.kind, 'terminated')),
  )

/** Up to `limit` due deliveries, oldest due first, claimed under `token` until the claim lapses. */
export function claimDue(db: Db, now: number, token: string, limit: number): readonly Claimed[] {
  return db.transaction((tx) => {
    const rows = tx
      .select({
        delivery: appPublishDeliveries,
        url: appPublishSubscriptions.url,
        secret: appPublishSubscriptions.secret,
      })
      .from(appPublishDeliveries)
      .innerJoin(appPublishSubscriptions, eq(appPublishSubscriptions.id, appPublishDeliveries.subscriptionId))
      .where(takeable(now))
      .orderBy(asc(appPublishDeliveries.nextAt), asc(appPublishDeliveries.seq))
      .limit(limit)
      .all()
    if (rows.length === 0) return []
    tx.update(appPublishDeliveries)
      .set({ claim: token, claimedUntil: now + CLAIM_MS })
      .where(
        inArray(
          appPublishDeliveries.seq,
          rows.map(({ delivery }) => delivery.seq),
        ),
      )
      .run()
    return rows.map(({ delivery, url, secret }) => ({ ...delivery, claim: token, url, secret }))
  })
}

/** The unclaimed wake waiting beside `row` for the same lease and chat, if a newer one came while `row` was out. */
const sibling = <R>(db: Db<R>, row: Delivery) =>
  row.chatId === null
    ? undefined
    : db
        .select()
        .from(appPublishDeliveries)
        .where(
          and(
            eq(appPublishDeliveries.subscriptionId, row.subscriptionId),
            eq(appPublishDeliveries.chatId, row.chatId),
            eq(appPublishDeliveries.kind, 'occurrence'),
            sql`${appPublishDeliveries.claim} IS NULL`,
            ne(appPublishDeliveries.seq, row.seq),
          ),
        )
        .get()

const noteError = <R>(db: Db<R>, lease: string, reason: CallbackReason | null, now: number) =>
  db
    .update(appPublishSubscriptions)
    .set({ lastError: reason, updatedAt: now })
    .where(eq(appPublishSubscriptions.id, lease))
    .run()

/** `row` goes out again at `at`; a newer wake for its chat takes its place, keeping its attempts and first time. */
function later<R>(db: Db<R>, row: Delivery, at: number): void {
  const newer = sibling(db, row)
  if (newer === undefined) {
    db.update(appPublishDeliveries)
      .set({ attempts: row.attempts + 1, nextAt: at, claim: null, claimedUntil: null })
      .where(eq(appPublishDeliveries.seq, row.seq))
      .run()
    return
  }
  db.delete(appPublishDeliveries).where(eq(appPublishDeliveries.seq, row.seq)).run()
  db.update(appPublishDeliveries)
    .set({
      attempts: Math.max(newer.attempts, row.attempts + 1),
      firstAt: Math.min(newer.firstAt, row.firstAt),
      nextAt: Math.max(newer.nextAt, at),
    })
    .where(eq(appPublishDeliveries.seq, newer.seq))
    .run()
}

/**
 * A wake given up on: every wake owed to its lease is dropped, one `gap` control (the position before the oldest of
 * them) is owed instead, and the lease is failing until a delivery reaches its URL again or it is renewed.
 */
function gapAfter<R>(db: Db<R>, row: Delivery, reason: CallbackReason, now: number): void {
  const lease = row.subscriptionId
  const owed = and(eq(appPublishDeliveries.subscriptionId, lease), eq(appPublishDeliveries.kind, 'occurrence'))
  const oldest = db
    .select({ seq: min(appPublishDeliveries.journalSeq) })
    .from(appPublishDeliveries)
    .where(owed)
    .get()
  db.delete(appPublishDeliveries).where(owed).run()
  const pending = db
    .select({ seq: appPublishDeliveries.seq })
    .from(appPublishDeliveries)
    .where(and(eq(appPublishDeliveries.subscriptionId, lease), eq(appPublishDeliveries.kind, 'gap')))
    .get()
  if (pending === undefined) {
    const cursor = cursorOf(Math.max(0, (oldest?.seq ?? row.journalSeq ?? 1) - 1))
    db.insert(appPublishDeliveries)
      .values({
        subscriptionId: lease,
        kind: 'gap',
        webhookId: controlId('gap'),
        body: JSON.stringify({ type: 'gap', cursor }),
        firstAt: now,
        nextAt: now,
      })
      .run()
  }
  db.update(appPublishSubscriptions)
    .set({ status: 'failing', lastError: reason, updatedAt: now })
    .where(and(eq(appPublishSubscriptions.id, lease), ne(appPublishSubscriptions.status, 'terminated')))
    .run()
}

/** A delivery done with for good: accepted or given up on. A lease's `terminated` control takes the lease with it. */
function done<R>(db: Db<R>, row: Delivery, reached: boolean, now: number): void {
  if (row.kind === 'terminated') {
    db.delete(appPublishDeliveries).where(eq(appPublishDeliveries.subscriptionId, row.subscriptionId)).run()
    db.delete(appPublishSubscriptions).where(eq(appPublishSubscriptions.id, row.subscriptionId)).run()
    return
  }
  db.delete(appPublishDeliveries).where(eq(appPublishDeliveries.seq, row.seq)).run()
  if (!reached) return
  // The URL answered again: a failing lease's deliveries go on.
  db.update(appPublishSubscriptions)
    .set({ status: 'active', lastError: null, updatedAt: now })
    .where(and(eq(appPublishSubscriptions.id, row.subscriptionId), eq(appPublishSubscriptions.status, 'failing')))
    .run()
}

/** One send of `row` settled as `decision`, if `row` is still claimed under `token`; a lapsed claim's answer is dropped. */
export function settle(db: Db, row: Delivery, token: string, decision: RetryDecision, now: number): void {
  db.transaction((tx) => {
    const current = tx.select().from(appPublishDeliveries).where(eq(appPublishDeliveries.seq, row.seq)).get()
    if (current?.claim !== token) return
    if (decision.state === 'accepted') {
      noteError(tx, current.subscriptionId, null, now)
      return done(tx, current, true, now)
    }
    noteError(tx, current.subscriptionId, decision.reason, now)
    if (decision.state === 'retry') return later(tx, current, decision.atMs)
    if (current.kind === 'occurrence') return gapAfter(tx, current, decision.reason, now)
    return done(tx, current, false, now)
  })
}

/** Deliveries whose lease is gone. */
export const pruneOrphans = <R>(db: Db<R>): void => {
  db.delete(appPublishDeliveries)
    .where(
      sql`${appPublishDeliveries.subscriptionId} NOT IN (SELECT ${appPublishSubscriptions.id} FROM ${appPublishSubscriptions})`,
    )
    .run()
}

/** When the next delivery or claim falls due, or the next lease ends, if any does. */
export function nextDue<R>(db: Db<R>): number | undefined {
  // Drizzle's `min` of an expression answers text; the time is read as the number it is.
  const delivery = db
    .select({
      at: sql<
        number | null
      >`min(CASE WHEN ${appPublishDeliveries.claim} IS NULL THEN ${appPublishDeliveries.nextAt} ELSE max(${appPublishDeliveries.nextAt}, ${appPublishDeliveries.claimedUntil}) END)`.mapWith(
        Number,
      ),
    })
    .from(appPublishDeliveries)
    .get()?.at
  const lease = db
    .select({ at: min(appPublishSubscriptions.refreshBefore) })
    .from(appPublishSubscriptions)
    .where(ne(appPublishSubscriptions.status, 'terminated'))
    .get()?.at
  const times = [delivery, lease].filter((at): at is number => typeof at === 'number')
  return times.length === 0 ? undefined : Math.min(...times)
}
