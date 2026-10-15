import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as Layer from 'effect/Layer'
import { DatabaseSync } from 'node:sqlite'
import { Db } from '../src/runtime/db.ts'
import { MIGRATIONS } from '../src/storage/migrations.ts'
import { BREAK } from '../src/storage/migrations/migration.ts'

/** Real SQLite with the fresh application baseline; native integrations exercise the Durable Object driver. */
export function chatDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS) for (const statement of migration.sql.split(BREAK)) sqlite.exec(statement)
  const db = drizzle({ client: sqlite })
  return { db, sqlite, close: () => sqlite.close() }
}

/** A test's database, as `chatDatabase` makes it. */
export type ChatDatabase = ReturnType<typeof chatDatabase>['db']

/** `db` as the stores take it: the Durable Object's Drizzle database. */
export const durable = (db: ChatDatabase): DrizzleSqliteDODatabase =>
  // SAFETY: the stores use only Drizzle's synchronous query builder, which node:sqlite's driver serves alike.
  db as never

/** The agent's database (`Db`) over `db`. */
export const sqliteDb = (db: ChatDatabase): Layer.Layer<Db> => Layer.succeed(Db, durable(db))
