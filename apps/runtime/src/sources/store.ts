// The rows of the owner's Sources (ADR 0066): their setups, where each conversation goes, what a conversation holds
// while it waits for a route, and the answers owed. Plain functions over the agent's SQLite; each write is one statement
// or one short transaction, never across a network call.
import {
  type SourceKeyValues,
  SourceKeyValues as SourceKeyValuesSchema,
  type SourceRoute,
  SourceSetup,
  type SourceSetup as Setup,
  type SourceWaiting,
} from '@goblin/contracts'
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Internal } from '../http/errors.ts'
import { appSourceHeld, appSourceReplies, appSourceRoutes, appSourceSetups } from '../storage/sources.ts'
import { holdNewest } from './held.ts'

type Db = DrizzleSqliteDODatabase

/** One Source's row. */
export type SourceRow = typeof appSourceSetups.$inferSelect

/** One conversation's route row. */
export type RouteRow = typeof appSourceRoutes.$inferSelect

/** One answer owed. */
export type ReplyRow = typeof appSourceReplies.$inferSelect

/** Who set a route: the owner, the agent on their request, or the setup's `newKeys` for a key seen first. */
export type RouteBy = 'owner' | 'agent' | 'default'

const decodeSetup = Schema.decodeUnknownOption(Schema.fromJsonString(SourceSetup))
const decodeValues = Schema.decodeUnknownOption(Schema.fromJsonString(SourceKeyValuesSchema))

/** A row's setup; none for a row that does not decode (goblin wrote it, so it always should). */
export const setupOf = (row: Pick<SourceRow, 'setup'>): Setup | undefined =>
  Option.getOrUndefined(decodeSetup(row.setup))

/** A route row's key values (none when they do not decode). */
export const valuesOf = (row: Pick<RouteRow, 'keyValues'>): SourceKeyValues =>
  Option.getOrElse(decodeValues(row.keyValues), () => ({}))

/** The Source `id`. */
export const sourceRow = (db: Db, id: string): SourceRow | undefined =>
  db.select().from(appSourceSetups).where(eq(appSourceSetups.id, id)).get()

/** Every Source, the newest first. */
export const sourceRows = (db: Db): readonly SourceRow[] =>
  db.select().from(appSourceSetups).orderBy(desc(appSourceSetups.createdAt), desc(appSourceSetups.id)).all()

/** The proposal `operationId` made, if it made one. */
export const proposalOf = (db: Db, operationId: string): SourceRow | undefined =>
  db.select().from(appSourceSetups).where(eq(appSourceSetups.operationId, operationId)).get()

/** A new proposal, as its revision 1; a repeat of the same operation changes nothing. The row it made. */
export function propose(
  db: Db,
  proposal: Pick<SourceRow, 'id' | 'operationId' | 'connectionId' | 'title' | 'proposedBy' | 'chatId'> & {
    readonly setup: Setup
  },
  now: number,
): SourceRow {
  const { setup, ...fields } = proposal
  db.insert(appSourceSetups)
    .values({
      ...fields,
      setup: JSON.stringify(setup),
      revision: 1,
      state: 'proposed',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run()
  const row = proposal.operationId === null ? undefined : proposalOf(db, proposal.operationId)
  const made = row ?? sourceRow(db, proposal.id)
  if (made === undefined) throw new Internal({ reason: 'source proposal not written' })
  return made
}

/** Changes `id`'s row: its state and what it is bound to; the time moves on. The row after. */
export function patchSource(db: Db, id: string, patch: Partial<SourceRow>, now: number): SourceRow | undefined {
  db.update(appSourceSetups)
    .set({ ...patch, updatedAt: now })
    .where(eq(appSourceSetups.id, id))
    .run()
  return sourceRow(db, id)
}

/** Moves a tool read's cursor on, while the Source is still bound at `binding`. */
export function checkpoint(db: Db, id: string, binding: number | null, cursor: string): void {
  db.update(appSourceSetups)
    .set({ cursor })
    .where(
      and(
        eq(appSourceSetups.id, id),
        binding === null ? isNull(appSourceSetups.binding) : eq(appSourceSetups.binding, binding),
      ),
    )
    .run()
}

/** Forgets Source `id`: its row, its routes, what it held and the answers it owed, in one transaction. */
export function forget(db: Db, id: string): void {
  db.transaction(() => {
    db.delete(appSourceHeld).where(eq(appSourceHeld.sourceId, id)).run()
    db.delete(appSourceReplies).where(eq(appSourceReplies.sourceId, id)).run()
    db.delete(appSourceRoutes).where(eq(appSourceRoutes.sourceId, id)).run()
    db.delete(appSourceSetups).where(eq(appSourceSetups.id, id)).run()
  })
}

/** A route row's route. */
export function routeOf(row: Pick<RouteRow, 'route' | 'topicId' | 'personaId'>): SourceRoute {
  const { topicId, personaId } = row
  if (row.route === 'persona' && topicId !== null && personaId !== null)
    return { to: 'persona', persona: personaId, topic: topicId }
  if ((row.route === 'topic' || row.route === 'listen') && topicId !== null) return { to: row.route, topic: topicId }
  return row.route === 'ignore' ? { to: 'ignore' } : { to: 'held' }
}

/** A route as its row's columns. */
const columnsOf = (route: SourceRoute) => ({
  route: route.to,
  topicId: route.to === 'topic' || route.to === 'listen' || route.to === 'persona' ? route.topic : null,
  personaId: route.to === 'persona' ? route.persona : null,
})

/** The route of `sourceId`'s conversation `key`. */
export const routeRow = (db: Db, sourceId: string, key: string): RouteRow | undefined =>
  db
    .select()
    .from(appSourceRoutes)
    .where(and(eq(appSourceRoutes.sourceId, sourceId), eq(appSourceRoutes.key, key)))
    .get()

/** Every conversation of `sourceId`, the newest first. */
export const routeRows = (db: Db, sourceId: string): readonly RouteRow[] =>
  db
    .select()
    .from(appSourceRoutes)
    .where(eq(appSourceRoutes.sourceId, sourceId))
    .orderBy(desc(appSourceRoutes.createdAt), asc(appSourceRoutes.key))
    .all()

/**
 * The route of `sourceId`'s conversation `key`, made with `first` (the setup's `newKeys`) when goblin sees it for the
 * first time. Whether it was new.
 */
export function seeKey(
  db: Db,
  conversation: { readonly sourceId: string; readonly key: string; readonly values: SourceKeyValues },
  first: SourceRoute,
  now: number,
): { readonly row: RouteRow; readonly created: boolean } {
  const known = routeRow(db, conversation.sourceId, conversation.key)
  if (known !== undefined) return { row: known, created: false }
  db.insert(appSourceRoutes)
    .values({
      sourceId: conversation.sourceId,
      key: conversation.key,
      keyValues: JSON.stringify(conversation.values),
      ...columnsOf(first),
      updatedBy: 'default',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run()
  const row = routeRow(db, conversation.sourceId, conversation.key)
  if (row === undefined) throw new Internal({ reason: 'source route not written' })
  return { row, created: true }
}

/** Sets where `sourceId`'s conversation `key` goes, as `by` chose it: its revision moves on. The row before and after. */
export function setRoute(
  db: Db,
  conversation: { readonly sourceId: string; readonly key: string },
  route: SourceRoute,
  by: RouteBy,
  now: number,
): { readonly before: RouteRow; readonly after: RouteRow } | undefined {
  return db.transaction(() => {
    const before = routeRow(db, conversation.sourceId, conversation.key)
    if (before === undefined) return undefined
    db.update(appSourceRoutes)
      .set({ ...columnsOf(route), revision: before.revision + 1, updatedBy: by, updatedAt: now })
      .where(and(eq(appSourceRoutes.sourceId, conversation.sourceId), eq(appSourceRoutes.key, conversation.key)))
      .run()
    const after = routeRow(db, conversation.sourceId, conversation.key)
    return after === undefined ? undefined : { before, after }
  })
}

/** A route receipt's target: the Source and its conversation's key, `<source>:<key>`. */
export const routeTarget = (sourceId: string, key: string) => `${sourceId}:${key}`

/** A route receipt's target as its Source and key (a Source's id holds no `:`). */
export function targetOf(target: string): { readonly sourceId: string; readonly key: string } {
  const split = target.indexOf(':')
  return { sourceId: target.slice(0, split), key: target.slice(split + 1) }
}

/** The revision a `source.route` receipt's target is at now; none when it is gone. */
export function routeRevision(db: Db, target: string): number | undefined {
  const { sourceId, key } = targetOf(target)
  return routeRow(db, sourceId, key)?.revision
}

/** One owner message held while its conversation waits: its id, its conversation and its words. */
export type Held = { readonly sourceId: string; readonly itemId: string; readonly key: string; readonly text: string }

/** Holds `held` until its conversation has a route, keeping the twenty newest of it (sources/held.ts). */
export function hold(db: Db, held: Held, now: number): void {
  const conversation = and(eq(appSourceHeld.sourceId, held.sourceId), eq(appSourceHeld.key, held.key))
  holdNewest(db, {
    put: () =>
      db
        .insert(appSourceHeld)
        .values({ ...held, heldAt: now })
        .onConflictDoNothing()
        .run(),
    newestFirst: () =>
      db
        .select({ itemId: appSourceHeld.itemId })
        .from(appSourceHeld)
        .where(conversation)
        .orderBy(sql`rowid DESC`)
        .all()
        .map(({ itemId }) => itemId),
    drop: (dropped) => {
      db.delete(appSourceHeld)
        .where(and(eq(appSourceHeld.sourceId, held.sourceId), inArray(appSourceHeld.itemId, [...dropped])))
        .run()
      db.update(appSourceRoutes)
        .set({ heldDropped: sql`${appSourceRoutes.heldDropped} + ${dropped.length}` })
        .where(and(eq(appSourceRoutes.sourceId, held.sourceId), eq(appSourceRoutes.key, held.key)))
        .run()
    },
  })
}

/** What `sourceId`'s conversation `key` holds, oldest first. */
export const heldOf = (db: Db, sourceId: string, key: string): readonly Held[] =>
  db
    .select({
      sourceId: appSourceHeld.sourceId,
      itemId: appSourceHeld.itemId,
      key: appSourceHeld.key,
      text: appSourceHeld.text,
    })
    .from(appSourceHeld)
    .where(and(eq(appSourceHeld.sourceId, sourceId), eq(appSourceHeld.key, key)))
    .orderBy(sql`rowid`)
    .all()

/** A held message went on to its route. */
export function release(db: Db, sourceId: string, itemId: string): void {
  db.delete(appSourceHeld)
    .where(and(eq(appSourceHeld.sourceId, sourceId), eq(appSourceHeld.itemId, itemId)))
    .run()
}

/** How many held messages of a conversation were dropped past the twenty kept, now told: the count starts again. */
export function takeDropped(db: Db, sourceId: string, key: string): number {
  return db.transaction(() => {
    const dropped = routeRow(db, sourceId, key)?.heldDropped ?? 0
    if (dropped > 0)
      db.update(appSourceRoutes)
        .set({ heldDropped: 0 })
        .where(and(eq(appSourceRoutes.sourceId, sourceId), eq(appSourceRoutes.key, key)))
        .run()
    return dropped
  })
}

/** How many messages each conversation of `sourceId` holds, by key. */
export function heldCounts(db: Db, sourceId: string): ReadonlyMap<string, number> {
  const rows = db
    .select({ key: appSourceHeld.key, held: count() })
    .from(appSourceHeld)
    .where(eq(appSourceHeld.sourceId, sourceId))
    .groupBy(appSourceHeld.key)
    .all()
  return new Map(rows.map(({ key, held }) => [key, held]))
}

/** The conversations of `sourceId` waiting for the owner's route, the newest twenty, with what each holds. */
export function waitingOf(db: Db, sourceId: string): readonly SourceWaiting[] {
  const held = heldCounts(db, sourceId)
  return db
    .select()
    .from(appSourceRoutes)
    .where(and(eq(appSourceRoutes.sourceId, sourceId), eq(appSourceRoutes.route, 'held')))
    .orderBy(desc(appSourceRoutes.updatedAt))
    .limit(20)
    .all()
    .map((row) => ({ key: row.key, values: valuesOf(row), held: held.get(row.key) ?? 0 }))
}

/** Remembers a turn whose answer goes back through its Source; whether it was new. */
export function trackReply(
  db: Db,
  reply: Pick<ReplyRow, 'operationId' | 'sourceId' | 'key' | 'chatId' | 'personaId'>,
  now: number,
): boolean {
  const written = db
    .insert(appSourceReplies)
    .values({ ...reply, createdAt: now })
    .onConflictDoNothing()
    .returning({ operationId: appSourceReplies.operationId })
    .all()
  return written.length > 0
}

/** The answers owed whose next try is due at `now`, the oldest first. */
export const dueReplies = (db: Db, now: number): readonly ReplyRow[] =>
  db
    .select()
    .from(appSourceReplies)
    .where(and(isNull(appSourceReplies.outcome), lte(appSourceReplies.nextAt, now)))
    .orderBy(asc(appSourceReplies.createdAt))
    .all()

/** The earliest next try of an answer owed, if any is owed. */
export function nextReply(db: Db): number | undefined {
  return db
    .select({ nextAt: appSourceReplies.nextAt })
    .from(appSourceReplies)
    .where(isNull(appSourceReplies.outcome))
    .orderBy(asc(appSourceReplies.nextAt))
    .get()?.nextAt
}

/** An answer went out, or was given up, at `now`. */
export function settleReply(db: Db, operationId: string, outcome: 'sent' | 'given_up', now: number): void {
  db.update(appSourceReplies)
    .set({ outcome, settledAt: now })
    .where(and(eq(appSourceReplies.operationId, operationId), isNull(appSourceReplies.outcome)))
    .run()
}

/** A try of an answer failed: it is tried again at `nextAt`, `attempts` counting. */
export function retryReply(db: Db, operationId: string, attempts: number, nextAt: number): void {
  db.update(appSourceReplies)
    .set({ attempts, nextAt })
    .where(and(eq(appSourceReplies.operationId, operationId), isNull(appSourceReplies.outcome)))
    .run()
}
