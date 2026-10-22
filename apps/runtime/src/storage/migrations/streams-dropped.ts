import { BREAK, type Migration } from './migration.ts'

/**
 * The chat streams' tables go (ADR 0110): the agent serves each chat's stream to the readers connected to it and keeps
 * nothing for it, so the epochs and the outbox an agent of ADR 0109 stored are dropped. A fresh agent never had them.
 * Additive so production keeps its agents; it leaves the baseline at the next reset the owner decides on.
 */
export const STREAMS_DROPPED: Migration = {
  key: '20261023000000_streams_dropped',
  tables: ['app_streams', 'app_stream_outbox'],
  sql: ['DROP TABLE IF EXISTS app_stream_outbox', 'DROP TABLE IF EXISTS app_streams'].join(BREAK),
}
