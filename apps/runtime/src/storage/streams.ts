import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * A chat's stream in one tier (docs/architecture/streams.md): its current epoch, the producer sequence number its next
 * append takes, the bytes appended in the epoch, when the epoch began (epoch ms), and the translator's cursor as of the
 * newest append (`streams/agui.ts` `StreamCursor`, JSON).
 */
export const appStreams = sqliteTable(
  'app_streams',
  {
    chatId: text('chat_id').notNull(),
    tier: text('tier', { enum: ['full', 'answers'] }).notNull(),
    epoch: integer('epoch').notNull(),
    nextSeq: integer('next_seq').notNull(),
    bytes: integer('bytes').notNull(),
    startedAt: integer('started_at').notNull(),
    cursorJson: text('cursor_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.tier] })],
)

/**
 * Appends written but not yet acknowledged, by stream (`<chat>/<tier>`), epoch and sequence number: `-1` creates the
 * epoch's stream with its opening events, an empty body closes it, anything else is a JSON array of events appended
 * with that producer sequence number. A row is deleted once the stream acknowledged it, so a retry resends its bytes.
 */
export const appStreamOutbox = sqliteTable(
  'app_stream_outbox',
  {
    stream: text('stream').notNull(),
    epoch: integer('epoch').notNull(),
    seq: integer('seq').notNull(),
    body: text('body').notNull(),
  },
  (table) => [primaryKey({ columns: [table.stream, table.epoch, table.seq] })],
)
