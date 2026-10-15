import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as Layer from 'effect/Layer'
import { DatabaseSync } from 'node:sqlite'
import { Db } from '../src/runtime/db.ts'
import { MIGRATIONS } from '../src/storage/migrations.ts'
import { BREAK } from '../src/storage/migrations/migration.ts'

/** Where `chatDatabase` stops or resumes the migrations: after the key `after` (else the first), through `through`. */
type MigrationRange = { readonly after?: string; readonly through?: string }

/** The statements of the application migrations in `range`, in order. */
function migrationStatements(range: MigrationRange): string[] {
  const keys = MIGRATIONS.map((migration) => migration.key)
  const start = range.after === undefined ? 0 : keys.indexOf(range.after) + 1
  const end = range.through === undefined ? keys.length : keys.indexOf(range.through) + 1
  if (start === 0 && range.after !== undefined) throw new Error(`Unknown migration ${range.after}`)
  if (end === 0) throw new Error(`Unknown migration ${String(range.through)}`)
  return MIGRATIONS.slice(start, end).flatMap((migration) => migration.sql.split(BREAK))
}

/**
 * Real SQLite with the application migrations applied, for directory, Topic and memory unit tests; native integrations
 * separately exercise the Durable Object driver. `range` stops or resumes the migrations around seeded data.
 */
export function chatDatabase(range: MigrationRange = {}) {
  const sqlite = new DatabaseSync(':memory:')
  const migrate = (next: MigrationRange) => {
    for (const statement of migrationStatements(next)) sqlite.exec(statement)
  }
  migrate(range)
  const db = drizzle({ client: sqlite })
  return { db, sqlite, migrate, close: () => sqlite.close() }
}

/** A test's database, as `chatDatabase` makes it. */
export type ChatDatabase = ReturnType<typeof chatDatabase>['db']

/** `db` as the stores take it: the Durable Object's Drizzle database. */
export const durable = (db: ChatDatabase): DrizzleSqliteDODatabase =>
  // SAFETY: the stores use only Drizzle's synchronous query builder, which node:sqlite's driver serves alike.
  db as never

/** The agent's database (`Db`) over `db`. */
export const sqliteDb = (db: ChatDatabase): Layer.Layer<Db> => Layer.succeed(Db, durable(db))
