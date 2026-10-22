import { BREAK, type Migration } from './migration.ts'

/**
 * The MCP servers a key declares on its threads, and the operations that set them (ADR 0103). Additive so production
 * keeps its agents; it folds into the baseline at the next reset the owner decides on.
 */
export const THREAD_SERVERS: Migration = {
  key: '20261022170000_thread_servers',
  tables: ['app_thread_servers', 'app_thread_server_ops'],
  sql: [
    'CREATE TABLE app_thread_servers (chat_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, origin TEXT NOT NULL, tools TEXT NOT NULL, token TEXT NOT NULL, key_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, name))',
    'CREATE INDEX app_thread_servers_key ON app_thread_servers (key_id)',
    'CREATE TABLE app_thread_server_ops (chat_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, operation_id))',
  ].join(BREAK),
}
