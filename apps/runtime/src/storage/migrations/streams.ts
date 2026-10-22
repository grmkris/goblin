import { BREAK, type Migration } from './migration.ts'

/**
 * Each chat's AG-UI streams (docs/architecture/streams.md): one row per chat and tier with its epoch, the producer's
 * next sequence number, the bytes appended, when the epoch began and the translator's cursor; and the appends not yet
 * acknowledged, each with the exact bytes a retry resends. Additive so production keeps its agents.
 */
export const STREAMS: Migration = {
  key: '20261022190000_streams',
  tables: ['app_streams', 'app_stream_outbox'],
  sql: [
    "CREATE TABLE app_streams (chat_id TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('full', 'answers')), epoch INTEGER NOT NULL, next_seq INTEGER NOT NULL, bytes INTEGER NOT NULL, started_at INTEGER NOT NULL, cursor_json TEXT NOT NULL, PRIMARY KEY (chat_id, tier))",
    'CREATE TABLE app_stream_outbox (stream TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (stream, epoch, seq))',
  ].join(BREAK),
}
