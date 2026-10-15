import { BREAK, type Migration } from './migration.ts'

/**
 * Sources (ADR 0066, keys from `20261102000`): the setups the owner confirms on any connection that sends events, where
 * each conversation goes, what waits for a route and the answers owed; then "Notify me via"; then each conversation's
 * title and the files a held message brought. Added by their own migrations, so dev and prod keep their data.
 */
export const SOURCE_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261102000100_sources',
    tables: ['app_source_setups', 'app_source_routes', 'app_source_held', 'app_source_replies'],
    sql: [
      `CREATE TABLE app_source_setups (id TEXT PRIMARY KEY NOT NULL, operation_id TEXT UNIQUE, connection_id TEXT NOT NULL, title TEXT NOT NULL, setup TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('proposed', 'active', 'paused', 'refused')), paused TEXT CHECK (paused IN ('owner', 'review')), health TEXT, proposed_by TEXT NOT NULL CHECK (proposed_by IN ('owner', 'agent')), chat_id TEXT, endpoint TEXT, grant_version TEXT, binding INTEGER, cursor TEXT, pull_due INTEGER NOT NULL DEFAULT 0, resubscribe_due INTEGER NOT NULL DEFAULT 0, confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE app_source_routes (source_id TEXT NOT NULL, key TEXT NOT NULL, key_values TEXT NOT NULL, route TEXT NOT NULL CHECK (route IN ('topic', 'persona', 'listen', 'ignore', 'held')), topic_id INTEGER, persona_id INTEGER, held_dropped INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, updated_by TEXT CHECK (updated_by IN ('owner', 'agent', 'default')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (source_id, key), CHECK ((route IN ('topic', 'persona', 'listen')) = (topic_id IS NOT NULL)), CHECK ((route = 'persona') = (persona_id IS NOT NULL)))`,
      'CREATE TABLE app_source_held (source_id TEXT NOT NULL, item_id TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, held_at INTEGER NOT NULL, PRIMARY KEY (source_id, item_id))',
      'CREATE INDEX app_source_held_key ON app_source_held (source_id, key)',
      `CREATE TABLE app_source_replies (operation_id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, key TEXT NOT NULL, chat_id TEXT, persona_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, outcome TEXT CHECK (outcome IN ('sent', 'given_up')), created_at INTEGER NOT NULL, settled_at INTEGER)`,
      'CREATE INDEX app_source_replies_due ON app_source_replies (outcome, next_at)',
    ].join(BREAK),
  },
  {
    key: '20261102000200_notify_sink',
    tables: ['app_notify_sink'],
    sql: `CREATE TABLE app_notify_sink (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), connection_id TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, policy TEXT NOT NULL DEFAULT '{}', revision TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`,
  },
  {
    key: '20261102000300_source_parity',
    tables: ['app_source_routes', 'app_source_held'],
    sql: [
      'ALTER TABLE app_source_routes ADD COLUMN title TEXT',
      'ALTER TABLE app_source_held ADD COLUMN files TEXT',
    ].join(BREAK),
  },
]
