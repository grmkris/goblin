import { BREAK, type Migration } from './migration.ts'

/**
 * The name of the key that made a Topic or Persona, and the lookup by resource that views read (ADR 0108's, which ADR
 * 0115 replaced; the table is `app_made_by` since `SEALED`). Additive so production keeps its agents; it folds into the
 * baseline at the next reset the owner decides on.
 */
export const ROOMS: Migration = {
  key: '20261022180000_rooms',
  tables: ['app_key_reach'],
  sql: [
    'ALTER TABLE app_key_reach ADD COLUMN key_name TEXT',
    'CREATE INDEX app_key_reach_resource ON app_key_reach (kind, resource_id)',
  ].join(BREAK),
}
