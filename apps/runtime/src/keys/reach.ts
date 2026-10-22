import { type SQL, and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appKeyReach } from '../storage/keys.ts'

/** What a server API key can reach (ADR 0081): the Topics and Personas it made. */
export type ReachKind = 'topic' | 'persona'

/** Whether key `keyId` made the `kind` with `id`. */
export const hasReach = (db: DrizzleSqliteDODatabase, keyId: string, kind: ReachKind, id: number): boolean =>
  db
    .select({ keyId: appKeyReach.keyId })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.keyId, keyId), eq(appKeyReach.kind, kind), eq(appKeyReach.resourceId, id)))
    .get() !== undefined

/**
 * Whether Topic `topic` is a room (ADR 0108): a server's key made it, so every chat under it reaches only it, and its
 * work is a server's (ADR 0087).
 */
export const roomOf = <RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>, topic: number): boolean =>
  db
    .select({ keyId: appKeyReach.keyId })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.kind, 'topic'), eq(appKeyReach.resourceId, topic)))
    .get() !== undefined

/** A key as what it made records it: its id and its name (ADR 0108). */
type Maker = { readonly keyId: string; readonly name: string }

/** Records that key `key` made the `kind` with `id`, with the key's name; recording it again changes nothing. */
export const recordReach = (
  db: DrizzleSqliteDODatabase,
  key: Maker,
  kind: ReachKind,
  id: number,
  now: number,
): void => {
  db.insert(appKeyReach)
    .values({ keyId: key.keyId, kind, resourceId: id, createdAt: now, keyName: key.name })
    .onConflictDoNothing()
    .run()
}

/**
 * Names what key `key` made before names were kept (ADR 0108), in one statement, and answers what it named. A key's
 * name never changes, so a named row stays right.
 */
export const nameReach = (
  db: DrizzleSqliteDODatabase,
  key: Maker,
): readonly { readonly kind: ReachKind; readonly id: number }[] =>
  db
    .update(appKeyReach)
    .set({ keyName: key.name })
    .where(and(eq(appKeyReach.keyId, key.keyId), isNull(appKeyReach.keyName)))
    .returning({ kind: appKeyReach.kind, id: appKeyReach.resourceId })
    .all()

/** The ids of every `kind` key `keyId` made, as a subquery: a list of a key's own reads it in one statement. */
export const reachedIds = <RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>, keyId: string, kind: ReachKind) =>
  db
    .select({ id: appKeyReach.resourceId })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.keyId, keyId), eq(appKeyReach.kind, kind)))

/**
 * As a column of a query over `kind`'s rows, the key that made the row whose id is `id` (ADR 0108): its name, or its id
 * while its name is not known yet; null when no key made it.
 */
export const makerColumn = (kind: ReachKind, id: SQLiteColumn): SQL<string | null> =>
  sql<
    string | null
  >`(SELECT coalesce(${appKeyReach.keyName}, ${appKeyReach.keyId}) FROM ${appKeyReach} WHERE ${appKeyReach.kind} = ${kind} AND ${appKeyReach.resourceId} = ${id} LIMIT 1)`

/** The key that made the `kind` with `id`, as `makerColumn` names it; none when no key did. */
export const makerOf = <RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  kind: ReachKind,
  id: number,
): string | undefined =>
  db
    .select({ key: sql<string>`coalesce(${appKeyReach.keyName}, ${appKeyReach.keyId})` })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.kind, kind), eq(appKeyReach.resourceId, id)))
    .get()?.key
