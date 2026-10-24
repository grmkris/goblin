import { type SQL, and, eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appMadeBy } from '../storage/made-by.ts'

/**
 * Which installed app made a Topic or a Persona, for display only (ADRs 0114, 0115, 0118): views name it, and the
 * sidebar groups by it. What a credential reaches is its grant's (`grants/`), and what a turn may do its senders' power
 * (`grants/power.ts`), never this.
 */

/** What an app can make: a Topic or a Persona. */
export type MadeKind = 'topic' | 'persona'

/** A server as what it made records it: its credential's id and its name (ADR 0115). */
type Maker = { readonly id: string; readonly name: string }

/** Records that `maker` made the `kind` with `id`, with its name; recording it again changes nothing. */
export const recordMaker = (
  db: DrizzleSqliteDODatabase,
  maker: Maker,
  kind: MadeKind,
  id: number,
  now: number,
): void => {
  db.insert(appMadeBy)
    .values({ makerId: maker.id, kind, resourceId: id, createdAt: now, makerName: maker.name })
    .onConflictDoNothing()
    .run()
}

/**
 * As a column of a query over `kind`'s rows, the server that made the row whose id is `id` (ADR 0115): its name, or its
 * id where none was kept; null when none made it.
 */
export const makerColumn = (kind: MadeKind, id: SQLiteColumn): SQL<string | null> =>
  sql<
    string | null
  >`(SELECT coalesce(${appMadeBy.makerName}, ${appMadeBy.makerId}) FROM ${appMadeBy} WHERE ${appMadeBy.kind} = ${kind} AND ${appMadeBy.resourceId} = ${id} LIMIT 1)`

/** The server that made the `kind` with `id`, as `makerColumn` names it; none when none did. */
export const makerOf = <RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  kind: MadeKind,
  id: number,
): string | undefined =>
  db
    .select({ maker: sql<string>`coalesce(${appMadeBy.makerName}, ${appMadeBy.makerId})` })
    .from(appMadeBy)
    .where(and(eq(appMadeBy.kind, kind), eq(appMadeBy.resourceId, id)))
    .get()?.maker
