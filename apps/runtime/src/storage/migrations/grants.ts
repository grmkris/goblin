import { BREAK, type Migration } from './migration.ts'

/**
 * One grant for every credential (ADR 0114): the mirror of the grants that reach the agent, a thread's declared
 * servers kept under the grant that declared them (a key's grant has the key's id, so every row stays valid), and the
 * grant each published Events lease was made under. A key's leases take its grant at once; a client's ended, since the
 * agent cannot know a client's grant before its next request (it subscribes again). The grants of the keys that hold
 * leases are mirrored as reaching every Topic, as the auth store's own transform made them, until their next request
 * reads them again. Forward, so production keeps its agents.
 */
export const GRANTS: Migration = {
  key: '20261023200000_grants',
  tables: ['app_grant_sync', 'app_grant_reach', 'app_thread_servers', 'app_publish_subscriptions'],
  sql: [
    "CREATE TABLE app_grant_sync (grant_id TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, topics TEXT NOT NULL, personas TEXT NOT NULL, connections TEXT NOT NULL, synced_at INTEGER NOT NULL)",
    'CREATE TABLE app_grant_reach (grant_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY (grant_id, kind, resource_id))',
    'DROP INDEX app_thread_servers_key',
    'ALTER TABLE app_thread_servers RENAME COLUMN key_id TO grant_id',
    'CREATE INDEX app_thread_servers_grant ON app_thread_servers (grant_id)',
    'ALTER TABLE app_publish_subscriptions ADD COLUMN grant_id TEXT',
    "UPDATE app_publish_subscriptions SET grant_id = substr(principal, 5) WHERE principal LIKE 'key:%'",
    "UPDATE app_publish_subscriptions SET status = 'terminated' WHERE principal LIKE 'client:%' AND status <> 'terminated'",
    "INSERT OR IGNORE INTO app_grant_sync (grant_id, generation, topics, personas, connections, synced_at) SELECT DISTINCT grant_id, -1, 'all', 'all', 'list', 0 FROM app_publish_subscriptions WHERE grant_id IS NOT NULL",
  ].join(BREAK),
}
