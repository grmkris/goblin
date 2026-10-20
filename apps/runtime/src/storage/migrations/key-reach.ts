import type { Migration } from './migration.ts'

/**
 * What server API keys made (ADR 0081). Additive so production keeps its agents; it folds into the baseline at the next
 * reset the owner decides on.
 */
export const KEY_REACH: Migration = {
  key: '20261020000000_key_reach',
  tables: ['app_key_reach'],
  sql: "CREATE TABLE app_key_reach (key_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('topic', 'persona')), resource_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (key_id, kind, resource_id))",
}
