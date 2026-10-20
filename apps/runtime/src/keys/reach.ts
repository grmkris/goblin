import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
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

/** Whether any server key made the `kind` with `id` (ADR 0087). */
export const madeByKey = (db: DrizzleSqliteDODatabase, kind: ReachKind, id: number): boolean =>
  db
    .select({ keyId: appKeyReach.keyId })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.kind, kind), eq(appKeyReach.resourceId, id)))
    .get() !== undefined

/** Records that key `keyId` made the `kind` with `id`; recording it again changes nothing. */
export const recordReach = (
  db: DrizzleSqliteDODatabase,
  keyId: string,
  kind: ReachKind,
  id: number,
  now: number,
): void => {
  db.insert(appKeyReach).values({ keyId, kind, resourceId: id, createdAt: now }).onConflictDoNothing().run()
}

/** The ids of every `kind` key `keyId` made, as a subquery: a list of a key's own reads it in one statement. */
export const reachedIds = <RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>, keyId: string, kind: ReachKind) =>
  db
    .select({ id: appKeyReach.resourceId })
    .from(appKeyReach)
    .where(and(eq(appKeyReach.keyId, keyId), eq(appKeyReach.kind, kind)))
