import { BREAK, type Migration } from './migration.ts'

/**
 * The MCP Events goblin publishes (ADR 0112): the journal and its position, the chats waiting to be looked at, the
 * leases integrators hold and the deliveries owed to them (`storage/publish.ts`). Additive so production keeps its
 * agents; it folds into the baseline at the next reset the owner decides on.
 */
export const PUBLISH: Migration = {
  key: '20261023010000_publish',
  tables: [
    'app_publish_position',
    'app_publish_journal',
    'app_publish_dirty',
    'app_publish_subscriptions',
    'app_publish_deliveries',
  ],
  sql: [
    'CREATE TABLE app_publish_position (id INTEGER PRIMARY KEY, head INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0, polled_at INTEGER)',
    'CREATE TABLE app_publish_journal (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id INTEGER NOT NULL, data_json TEXT NOT NULL, at INTEGER NOT NULL)',
    'CREATE INDEX app_publish_journal_chat ON app_publish_journal (chat_id, seq)',
    'CREATE TABLE app_publish_dirty (chat_id TEXT PRIMARY KEY NOT NULL, since INTEGER NOT NULL)',
    "CREATE TABLE app_publish_subscriptions (id TEXT PRIMARY KEY NOT NULL, principal TEXT NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL, topic_id INTEGER, chat_id TEXT, url TEXT NOT NULL, secret TEXT NOT NULL, refresh_before INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'failing', 'terminated')), last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    'CREATE INDEX app_publish_subscriptions_principal ON app_publish_subscriptions (principal)',
    "CREATE TABLE app_publish_deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('occurrence', 'gap', 'terminated')), chat_id TEXT, journal_seq INTEGER, webhook_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, next_at INTEGER NOT NULL, claim TEXT, claimed_until INTEGER)",
    'CREATE INDEX app_publish_deliveries_due ON app_publish_deliveries (next_at)',
    "CREATE UNIQUE INDEX app_publish_deliveries_waiting ON app_publish_deliveries (subscription_id, chat_id) WHERE kind = 'occurrence' AND claim IS NULL",
  ].join(BREAK),
}
