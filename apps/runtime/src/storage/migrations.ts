import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { BASELINE } from './migrations/baseline.ts'
import { KEY_REACH } from './migrations/key-reach.ts'
import { assertApplicationTable } from './vendor.ts'

/**
 * The fresh application baseline, then the additive migrations production needed without a reset (ADR 0081). An edit
 * to the baseline ships only with a disposable dev reset.
 *
 * @internal Unit tests apply these same statements to SQLite and compare them with the live Drizzle declarations.
 */
export const MIGRATIONS = [BASELINE, KEY_REACH] as const

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
