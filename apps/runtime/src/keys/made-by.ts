import { type SQL, and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appMadeBy } from '../storage/made-by.ts'

/**
 * Which server's key made a Topic or a Persona, for display only (ADRs 0114, 0115): views name it, and the sidebar
 * groups by it. What a credential reaches is its grant's (`grants/`), and what a turn may do its senders' power
 * (`grants/power.ts`), never this.
 */

/** What a key can make: a Topic or a Persona. */
export type MadeKind = 'topic' | 'persona'

/** A key as what it made records it: its id and its name (ADR 0115). */
type Maker = { readonly keyId: string; readonly name: string }

/** Records that key `key` made the `kind` with `id`, with the key's name; recording it again changes nothing. */
export const recordMaker = (db: DrizzleSqliteDODatabase, key: Maker, kind: MadeKind, id: number, now: number): void => {
  db.insert(appMadeBy)
    .values({ keyId: key.keyId, kind, resourceId: id, createdAt: now, keyName: key.name })
    .onConflictDoNothing()
    .run()
}

/**
 * Names what key `key` made before names were kept (ADR 0115), in one statement, and answers what it named. A key's
 * name stays its own, so a named row stays right.
 */
export const nameMade = (
  db: DrizzleSqliteDODatabase,
  key: Maker,
): readonly { readonly kind: MadeKind; readonly id: number }[] =>
  db
    .update(appMadeBy)
    .set({ keyName: key.name })
    .where(and(eq(appMadeBy.keyId, key.keyId), isNull(appMadeBy.keyName)))
    .returning({ kind: appMadeBy.kind, id: appMadeBy.resourceId })
    .all()

/**
 * As a column of a query over `kind`'s rows, the key that made the row whose id is `id` (ADR 0115): its name, or its id
 * while its name is not known yet; null when no key made it.
 */
export const makerColumn = (kind: MadeKind, id: SQLiteColumn): SQL<string | null> =>
  sql<
    string | null
  >`(SELECT coalesce(${appMadeBy.keyName}, ${appMadeBy.keyId}) FROM ${appMadeBy} WHERE ${appMadeBy.kind} = ${kind} AND ${appMadeBy.resourceId} = ${id} LIMIT 1)`

/** The key that made the `kind` with `id`, as `makerColumn` names it; none when no key did. */
export const makerOf = <RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  kind: MadeKind,
  id: number,
): string | undefined =>
  db
    .select({ key: sql<string>`coalesce(${appMadeBy.keyName}, ${appMadeBy.keyId})` })
    .from(appMadeBy)
    .where(and(eq(appMadeBy.kind, kind), eq(appMadeBy.resourceId, id)))
    .get()?.key
