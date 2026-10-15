import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { BASELINE } from './migrations/baseline.ts'
import { assertApplicationTable } from './vendor.ts'

/**
 * The fresh application baseline. An edit to it ships only with a disposable dev reset.
 *
 * @internal Unit tests apply these same statements to SQLite and compare them with the live Drizzle declarations.
 */
export const MIGRATIONS = [BASELINE] as const

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
