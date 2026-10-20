import { type SQL, and, eq, lt, or } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * Pages of a table newest change first (`updated_at` then `id`, both descending), behind an opaque cursor
 * `<updatedAt>.<id>`: the last row the page before answered (`PageCursor`). A row changed while a caller pages moves to
 * the front, so a page may repeat a row or miss one changed meanwhile, never fail.
 */
export interface Paged {
  readonly updatedAt: SQLiteColumn
  readonly id: SQLiteColumn
}

/** The rows after `cursor` in the order of `columns`; none to leave out without one. */
export const after = (columns: Paged, cursor: string | undefined): SQL | undefined => {
  if (cursor === undefined) return undefined
  const [updatedAt = 0, id = 0] = cursor.split('.').map(Number)
  return or(lt(columns.updatedAt, updatedAt), and(eq(columns.updatedAt, updatedAt), lt(columns.id, id)))
}

/** One page of `rows`, read with one more than `limit`: those it answers, and the cursor of the next when more remain. */
export const pageOf = <Row extends { readonly updatedAt: number; readonly id: number }>(
  rows: readonly Row[],
  limit: number,
): { readonly rows: readonly Row[]; readonly next?: string } => {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return rows.length > limit && last !== undefined
    ? { rows: page, next: `${last.updatedAt}.${last.id}` }
    : { rows: page }
}
