import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
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
