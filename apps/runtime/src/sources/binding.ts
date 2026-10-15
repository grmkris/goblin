// Source changes after an asynchronous wait may write only the exact setup and binding they started from.
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appSourceSetups } from '../storage/sources.ts'
import type { SourceRow } from './store.ts'

/** One conditional statement; a stale operation never activates, pauses or unbinds a newer owner decision. */
export function patchCurrentSource(
  db: DrizzleSqliteDODatabase,
  row: SourceRow,
  patch: Partial<SourceRow>,
  now: number,
): SourceRow | undefined {
  return db
    .update(appSourceSetups)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(appSourceSetups.id, row.id),
        eq(appSourceSetups.revision, row.revision),
        eq(appSourceSetups.setup, row.setup),
        eq(appSourceSetups.state, row.state),
        eq(appSourceSetups.lastBinding, row.lastBinding),
        row.binding === null ? isNull(appSourceSetups.binding) : eq(appSourceSetups.binding, row.binding),
      ),
    )
    .returning()
    .get()
}

/** Reserve a never-reused consumer revision before network work. Clearing the active binding keeps this counter. */
export const reserveBinding = (db: DrizzleSqliteDODatabase, row: SourceRow, millis: number) =>
  patchCurrentSource(db, row, { lastBinding: Math.max(millis, row.lastBinding + 1) }, Math.floor(millis / 1000))
