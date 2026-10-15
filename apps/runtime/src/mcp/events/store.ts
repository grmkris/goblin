import { and, asc, count, desc, eq, gte, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Conflict, InvalidInput } from '../../http/errors.ts'
import {
  appEventConsumerReceipts as receipts,
  appEventDeliveries as deliveries,
  appMcpEventConsumers as consumers,
  appMcpEventGrants as grants,
  appMcpEventSubscriptions as subscriptions,
} from '../../storage/schema.ts'

export type Subscription = typeof subscriptions.$inferSelect
export type Consumer = typeof consumers.$inferSelect
export type Receipt = typeof receipts.$inferSelect
export type Delivery = typeof deliveries.$inferSelect
const CLEANUP_PENDING = 'cleanup_pending'
export const EVENT_LIMITS = {
  ttlMs: 3_600_000,
  minTtlMs: 300_000,
  maxTtlMs: 86_400_000,
  subscriptions: 64,
  listPages: 32,
  page: 100,
  bodyBytes: 262_144,
  timeoutMs: 15_000,
  pendingRows: 10_000,
  pendingBytes: 33_554_432,
  sweep: 256,
  retentionMs: 8 * 86_400_000,
} as const

const normalize = (input: unknown): unknown => {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (Array.isArray(input)) return input.map(normalize)
  if (typeof input === 'object' && input !== null)
    return Object.fromEntries(
      Object.entries(input)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    )
  throw new InvalidInput({ reason: 'event arguments must be JSON' })
}

/** Canonical JSON selectors: object key order is irrelevant, array order remains meaningful. */
export function canonicalArguments(value: unknown): string {
  const encoded = JSON.stringify(normalize(value))
  if (new TextEncoder().encode(encoded).length > 16_384) throw new InvalidInput({ reason: 'event arguments too large' })
  return encoded
}

export function pendingFits(rows: number, bytes: number, incoming: number): boolean {
  return rows < EVENT_LIMITS.pendingRows && bytes + incoming <= EVENT_LIMITS.pendingBytes
}

/** Database operations are synchronous and short; callers seal bytes before beginning a transaction. */
export class SqliteEventStore {
  readonly db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.db = db
  }

  grant(connectionId: string, name: string, argumentsJson: string, allowed: boolean, now: number): void {
    this.db
      .insert(grants)
      .values({ connectionId, name, argumentsJson, grantedAt: now, revokedAt: allowed ? null : now })
      .onConflictDoUpdate({
        target: [grants.connectionId, grants.name, grants.argumentsJson],
        set: { grantedAt: now, revokedAt: allowed ? null : now },
      })
      .run()
  }
  allows(connectionId: string, name: string, argumentsJson: string): boolean {
    return (
      this.db
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.connectionId, connectionId),
            eq(grants.name, name),
            eq(grants.argumentsJson, argumentsJson),
            isNull(grants.revokedAt),
          ),
        )
        .get() !== undefined
    )
  }
  /** Every subscription not tombstoned, however many: what maintenance reconciles and what the cap counts. */
  live(): Subscription[] {
    return this.db.select().from(subscriptions).where(ne(subscriptions.status, 'tombstone')).all()
  }
  /**
   * When a sweep next has work: the earliest lease refresh or poll of a subscription still running, or the earliest
   * retry of a delivery not yet processed. Nothing when nothing waits, so no alarm is kept for it.
   */
  nextDue(): number | undefined {
    const running = and(ne(subscriptions.status, 'tombstone'), ne(subscriptions.status, 'terminated'))
    const subscription = this.db
      .select({
        refresh: sql<number | null>`min(${subscriptions.nextRefreshAt})`,
        poll: sql<number | null>`min(${subscriptions.nextPollAt})`,
      })
      .from(subscriptions)
      .where(running)
      .get()
    const delivery = this.db
      .select({ retry: sql<number | null>`min(${deliveries.nextAttemptAt})` })
      .from(deliveries)
      .where(isNull(deliveries.processedAt))
      .get()
    const times = [subscription?.refresh, subscription?.poll, delivery?.retry].filter(
      (time): time is number => typeof time === 'number',
    )
    return times.length === 0 ? undefined : Math.min(...times)
  }
  /** How many subscriptions are live, for the cap. */
  count(): number {
    return (
      this.db.select({ rows: count() }).from(subscriptions).where(ne(subscriptions.status, 'tombstone')).get()?.rows ??
      0
    )
  }
  /** The rows a producer's subscription id names, tombstones included: a delivery to a gone one is answered 410. */
  byRemote(remoteId: string): Subscription[] {
    return this.db.select().from(subscriptions).where(eq(subscriptions.remoteId, remoteId)).all()
  }
  /** Intents still waiting for their verification, touched since `since`. */
  pendingSince(since: number): Subscription[] {
    return this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'pending'), gte(subscriptions.updatedAt, since)))
      .all()
  }
  get(id: string): Subscription | undefined {
    return this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).get()
  }
  selector(connectionId: string, name: string, argumentsJson: string): Subscription | undefined {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.connectionId, connectionId),
          eq(subscriptions.name, name),
          eq(subscriptions.argumentsJson, argumentsJson),
        ),
      )
      .get()
  }
  save(row: Subscription): void {
    this.db.insert(subscriptions).values(row).onConflictDoUpdate({ target: subscriptions.id, set: row }).run()
  }
  /** Encryption and alarm waits may not overwrite a lease changed while a replacement was prepared. */
  savePrepared(row: Subscription, previous: Subscription | undefined): boolean {
    if (previous === undefined)
      return this.db.insert(subscriptions).values(row).onConflictDoNothing().returning().all().length === 1
    return this.db.transaction((tx) => {
      const changed =
        tx
          .update(subscriptions)
          .set(row)
          .where(
            and(
              eq(subscriptions.id, previous.id),
              eq(subscriptions.secret, previous.secret),
              eq(subscriptions.status, previous.status),
              eq(subscriptions.updatedAt, previous.updatedAt),
            ),
          )
          .returning()
          .all().length === 1
      if (changed)
        tx.update(deliveries)
          .set({ processedAt: row.updatedAt })
          .where(and(eq(deliveries.subscriptionId, row.id), isNull(deliveries.processedAt)))
          .run()
      return changed
    })
  }

  /** Only the same live lease generation may accept an asynchronous response. */
  patchLive(row: Subscription, patch: Partial<Subscription>): boolean {
    return (
      this.db
        .update(subscriptions)
        .set(patch)
        .where(
          and(
            eq(subscriptions.id, row.id),
            eq(subscriptions.secret, row.secret),
            ne(subscriptions.status, 'tombstone'),
            ne(subscriptions.status, 'terminated'),
          ),
        )
        .returning()
        .all().length === 1
    )
  }
  /** Cleanup completion cannot change a later generation's cleanup status or state. */
  cleaned(row: Subscription, now: number): void {
    this.db
      .update(subscriptions)
      .set({ lastError: null, updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, row.id),
          eq(subscriptions.secret, row.secret),
          eq(subscriptions.status, 'tombstone'),
          eq(subscriptions.lastError, CLEANUP_PENDING),
        ),
      )
      .run()
  }
  patch(id: string, patch: Partial<Subscription>): void {
    this.db.update(subscriptions).set(patch).where(eq(subscriptions.id, id)).run()
  }
  bindings(subscriptionId: string): Consumer[] {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.subscriptionId, subscriptionId), eq(consumers.state, 'active')))
      .all()
  }
  activeConsumer(consumerId: string): Consumer | undefined {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.consumerId, consumerId), eq(consumers.state, 'active')))
      .get()
  }
  consumer(consumerId: string, revision: number): Consumer | undefined {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
      .get()
  }
  bind(row: Consumer, lease: Subscription): boolean {
    return this.db.transaction((tx) => {
      const latest = tx
        .select()
        .from(consumers)
        .where(eq(consumers.consumerId, row.consumerId))
        .orderBy(desc(consumers.revision))
        .get()
      const current = tx.select().from(subscriptions).where(eq(subscriptions.id, lease.id)).get()
      if (
        current?.secret !== lease.secret ||
        current.status === 'tombstone' ||
        (latest !== undefined &&
          (latest.revision > row.revision ||
            (latest.revision === row.revision &&
              (latest.state !== 'active' ||
                latest.subscriptionId !== row.subscriptionId ||
                latest.handlerKey !== row.handlerKey))))
      )
        return false
      tx.update(consumers)
        .set({ state: 'retiring', retiredAt: row.createdAt })
        .where(and(eq(consumers.consumerId, row.consumerId), eq(consumers.state, 'active')))
        .run()
      tx.insert(consumers)
        .values(row)
        .onConflictDoUpdate({ target: [consumers.consumerId, consumers.revision], set: row })
        .run()
      return true
    })
  }
  retire(consumerId: string, revision: number, now: number): void {
    this.db.transaction((tx) => {
      tx.update(consumers)
        .set({ state: 'retiring', retiredAt: now })
        .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
        .run()
      tx.update(receipts)
        .set({ state: 'retired', acceptedAt: now })
        .where(and(eq(receipts.consumerId, consumerId), eq(receipts.revision, revision), eq(receipts.state, 'pending')))
        .run()
    })
  }
  /** Retires a consumer and marks its last shared lease before any unsubscribe wait. */
  retireForCleanup(consumerId: string, revision: number, now: number): Subscription | undefined {
    return this.db.transaction((tx) => {
      const binding = tx
        .select()
        .from(consumers)
        .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
        .get()
      if (binding === undefined) return undefined
      tx.update(consumers)
        .set({ state: 'retiring', retiredAt: now })
        .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
        .run()
      tx.update(receipts)
        .set({ state: 'retired', acceptedAt: now })
        .where(and(eq(receipts.consumerId, consumerId), eq(receipts.revision, revision), eq(receipts.state, 'pending')))
        .run()
      const lease = tx.select().from(subscriptions).where(eq(subscriptions.id, binding.subscriptionId)).get()
      if (lease === undefined || lease.status === 'tombstone') return undefined
      const active = tx
        .select()
        .from(consumers)
        .where(and(eq(consumers.subscriptionId, lease.id), eq(consumers.state, 'active')))
        .limit(1)
        .get()
      if (active !== undefined) return undefined
      // Frozen deliveries belong to this retired generation, including controls with no remaining receipts.
      tx.update(deliveries)
        .set({ processedAt: now })
        .where(and(eq(deliveries.subscriptionId, lease.id), isNull(deliveries.processedAt)))
        .run()
      tx.update(subscriptions)
        .set({
          status: 'tombstone',
          lastError: CLEANUP_PENDING,
          nextRefreshAt: Number.MAX_SAFE_INTEGER,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, lease.id))
        .run()
      return lease
    })
  }
  delivery(subscriptionId: string, webhookId: string): Delivery | undefined {
    return this.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscriptionId, subscriptionId), eq(deliveries.webhookId, webhookId)))
      .get()
  }
  /** A dispatcher that crossed a decrypt/handler wait must still belong to the same unprocessed generation. */
  pendingDelivery(lease: Subscription, row: Delivery): boolean {
    const current = this.get(lease.id)
    return (
      current?.secret === lease.secret &&
      current.status !== 'tombstone' &&
      this.delivery(row.subscriptionId, row.webhookId)?.processedAt === null
    )
  }
  /** Receipt plus frozen consumer snapshot commit atomically; replay never regenerates that snapshot. */
  receiveLive(lease: Subscription, row: typeof deliveries.$inferInsert): boolean {
    return this.receive(row, lease)
  }
  receive(row: typeof deliveries.$inferInsert, lease?: Subscription): boolean {
    return this.db.transaction((tx) => {
      if (lease !== undefined) {
        const current = tx.select().from(subscriptions).where(eq(subscriptions.id, lease.id)).get()
        if (
          row.subscriptionId !== lease.id ||
          current?.secret !== lease.secret ||
          current.status === 'tombstone' ||
          current.status === 'terminated'
        )
          throw new Conflict({ reason: 'event lease changed' })
      }
      if (
        tx
          .select()
          .from(deliveries)
          .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
          .get() !== undefined
      )
        return false
      const pending = tx
        .select({ rows: count(), bytes: sql<number>`coalesce(sum(${deliveries.bytes}), 0)` })
        .from(deliveries)
        .where(isNull(deliveries.processedAt))
        .get()
      if (!pendingFits(pending?.rows ?? 0, pending?.bytes ?? 0, row.bytes))
        throw new InvalidInput({ reason: 'events backlog full' })
      tx.insert(deliveries).values(row).run()
      if (row.kind !== 'verification') {
        for (const binding of tx
          .select()
          .from(consumers)
          .where(and(eq(consumers.subscriptionId, row.subscriptionId), eq(consumers.state, 'active')))
          .all())
          tx.insert(receipts)
            .values({
              subscriptionId: row.subscriptionId,
              webhookId: row.webhookId,
              consumerId: binding.consumerId,
              revision: binding.revision,
              operationId: canonicalArguments([
                row.subscriptionId,
                row.webhookId,
                binding.consumerId,
                binding.revision,
              ]),
              state: 'pending',
            })
            .run()
      }
      return true
    })
  }
  work(now: number): Delivery[] {
    return this.db
      .select()
      .from(deliveries)
      .where(and(isNull(deliveries.processedAt), lte(deliveries.nextAttemptAt, now)))
      .orderBy(asc(deliveries.receivedAt))
      .limit(EVENT_LIMITS.sweep)
      .all()
  }
  snapshots(subscriptionId: string, webhookId: string): Receipt[] {
    return this.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.subscriptionId, subscriptionId), eq(receipts.webhookId, webhookId)))
      .all()
  }
  ack(
    input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
    now: number,
  ): void {
    this.db
      .update(receipts)
      .set({ state: 'accepted', acceptedAt: now })
      .where(
        and(
          eq(receipts.subscriptionId, input.subscriptionId),
          eq(receipts.webhookId, input.webhookId),
          eq(receipts.consumerId, input.consumerId),
          eq(receipts.revision, input.revision),
          eq(receipts.operationId, input.operationId),
          eq(receipts.state, 'pending'),
        ),
      )
      .run()
  }
  finish(subscriptionId: string, webhookId: string, now: number): boolean {
    if (this.snapshots(subscriptionId, webhookId).some((r) => r.state === 'pending')) return false
    this.db
      .update(deliveries)
      .set({ processedAt: now })
      .where(and(eq(deliveries.subscriptionId, subscriptionId), eq(deliveries.webhookId, webhookId)))
      .run()
    return true
  }
  retry(row: Delivery, now: number): void {
    this.db
      .update(deliveries)
      .set({
        attempts: row.attempts + 1,
        nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** Math.min(9, row.attempts)),
      })
      .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
      .run()
  }
  /**
   * Drops processed deliveries past retention, then tombstoned subscriptions that nothing refers to any more: no
   * delivery left and no active binding, with remote cleanup done or the producer's lease lapsed (until then a
   * delivery to it is answered 410).
   */
  prune(now: number): void {
    this.db.transaction((tx) => {
      const expired = tx
        .select()
        .from(deliveries)
        .where(lte(deliveries.processedAt, now - EVENT_LIMITS.retentionMs))
        .limit(EVENT_LIMITS.sweep)
        .all()
      for (const row of expired) {
        tx.delete(receipts)
          .where(and(eq(receipts.subscriptionId, row.subscriptionId), eq(receipts.webhookId, row.webhookId)))
          .run()
        tx.delete(deliveries)
          .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
          .run()
      }
      const retired = tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, 'tombstone'),
            or(
              isNull(subscriptions.lastError),
              isNull(subscriptions.refreshBefore),
              lt(subscriptions.refreshBefore, now),
            ),
          ),
        )
        .limit(EVENT_LIMITS.sweep)
        .all()
      for (const { id } of retired) {
        const delivery = tx.select().from(deliveries).where(eq(deliveries.subscriptionId, id)).limit(1).get()
        const bound = tx
          .select()
          .from(consumers)
          .where(and(eq(consumers.subscriptionId, id), eq(consumers.state, 'active')))
          .limit(1)
          .get()
        if (delivery !== undefined || bound !== undefined) continue
        tx.delete(consumers).where(eq(consumers.subscriptionId, id)).run()
        tx.delete(subscriptions).where(eq(subscriptions.id, id)).run()
      }
    })
  }
}
