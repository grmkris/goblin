import type { Migration } from './migration.ts'

/** The owner's own model endpoint (ADR 0059): added by its own migration. */
export const INFERENCE_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261101000100_model_endpoint',
    tables: ['app_model_endpoint'],
    sql: 'CREATE TABLE app_model_endpoint (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), base_url TEXT NOT NULL, key_sealed TEXT NOT NULL, models TEXT NOT NULL, model TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  },
]
