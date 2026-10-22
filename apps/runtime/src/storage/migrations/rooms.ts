import { BREAK, type Migration } from './migration.ts'

/**
 * Rooms (ADR 0108): the name of the key that made a Topic or Persona, and the lookup by resource that tells a room on
 * every tool call. Additive so production keeps its agents; it folds into the baseline at the next reset the owner
 * decides on.
 */
export const ROOMS: Migration = {
  key: '20261022180000_rooms',
  tables: ['app_key_reach'],
  sql: [
    'ALTER TABLE app_key_reach ADD COLUMN key_name TEXT',
    'CREATE INDEX app_key_reach_resource ON app_key_reach (kind, resource_id)',
  ].join(BREAK),
}
