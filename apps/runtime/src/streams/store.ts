import type { StreamTier } from '@goblin/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appStreamOutbox, appStreams } from '../storage/streams.ts'
import type { Write } from './writer.ts'

// A chat's streams in the agent's SQLite (`app_streams`, `app_stream_outbox`): each write is one short synchronous
// transaction, and nothing here waits on a stream or on Pi.

type Db = DrizzleSqliteDODatabase

/** A chat's stream in one tier as stored: its epoch, next sequence number, bytes, start and cursor (JSON). */
export type StoredStream = {
  readonly chat: string
  readonly tier: StreamTier
  readonly epoch: number
  readonly nextSeq: number
  readonly bytes: number
  readonly startedAt: number
  readonly cursorJson: string
}

/** One write not yet acknowledged, in the order it goes out. */
export type Pending = Write & { readonly epoch: number }

/** The outbox's name for a chat's stream of one tier, the same in every epoch. */
export const streamKey = (chat: string, tier: StreamTier): string => `${chat}/${tier}`

const stored = (row: typeof appStreams.$inferSelect): StoredStream => ({
  chat: row.chatId,
  tier: row.tier,
  epoch: row.epoch,
  nextSeq: row.nextSeq,
  bytes: row.bytes,
  startedAt: row.startedAt,
  cursorJson: row.cursorJson,
})

/** Every chat's streams. */
export const allStreams = (db: Db): StoredStream[] => db.select().from(appStreams).all().map(stored)

/** The chat's streams, in either tier. */
export const streamsOf = (db: Db, chat: string): StoredStream[] =>
  db.select().from(appStreams).where(eq(appStreams.chatId, chat)).all().map(stored)

/** The writes to make, as one epoch's next sequence numbers take them. */
const outboxRows = (key: string, epoch: number, writes: readonly Write[]) =>
  writes.map((write) => ({ stream: key, epoch, seq: write.seq, body: write.body }))

/**
 * A new epoch of the chat's stream in `stream.tier`: its row as it now is, and its writes (the create, then any
 * appends), with `closing` the old epoch's last writes (its `goblin.stream.moved` and its close), in one transaction.
 */
export function beginEpoch(
  db: Db,
  stream: StoredStream,
  writes: readonly Write[],
  closing?: { readonly epoch: number; readonly writes: readonly Write[] },
): void {
  const key = streamKey(stream.chat, stream.tier)
  const row = {
    chatId: stream.chat,
    tier: stream.tier,
    epoch: stream.epoch,
    nextSeq: stream.nextSeq,
    bytes: stream.bytes,
    startedAt: stream.startedAt,
    cursorJson: stream.cursorJson,
  }
  db.transaction((tx) => {
    tx.insert(appStreams)
      .values(row)
      .onConflictDoUpdate({ target: [appStreams.chatId, appStreams.tier], set: row })
      .run()
    const rows = [
      ...(closing === undefined ? [] : outboxRows(key, closing.epoch, closing.writes)),
      ...outboxRows(key, stream.epoch, writes),
    ]
    if (rows.length > 0) tx.insert(appStreamOutbox).values(rows).run()
  })
}

/** Appends to the stream's current epoch, with its row as it is after them, in one transaction. */
export function appendWrites(db: Db, stream: StoredStream, writes: readonly Write[]): void {
  const key = streamKey(stream.chat, stream.tier)
  db.transaction((tx) => {
    if (writes.length > 0)
      tx.insert(appStreamOutbox)
        .values(outboxRows(key, stream.epoch, writes))
        .run()
    tx.update(appStreams)
      .set({ nextSeq: stream.nextSeq, bytes: stream.bytes, cursorJson: stream.cursorJson })
      .where(and(eq(appStreams.chatId, stream.chat), eq(appStreams.tier, stream.tier)))
      .run()
  })
}

/** The stream's writes not yet acknowledged, oldest epoch first, each epoch in sequence order. */
export const pendingWrites = (db: Db, key: string): Pending[] =>
  db
    .select()
    .from(appStreamOutbox)
    .where(eq(appStreamOutbox.stream, key))
    .orderBy(asc(appStreamOutbox.epoch), asc(appStreamOutbox.seq))
    .all()
    .map(({ epoch, seq, body }) => ({ epoch, seq, body }))

/** The streams with writes not yet acknowledged. */
export const unsentStreams = (db: Db): string[] =>
  db
    .selectDistinct({ stream: appStreamOutbox.stream })
    .from(appStreamOutbox)
    .all()
    .map(({ stream }) => stream)

/** The stream acknowledged one write. */
export const acknowledged = (db: Db, key: string, write: Pending): void => {
  db.delete(appStreamOutbox)
    .where(
      and(eq(appStreamOutbox.stream, key), eq(appStreamOutbox.epoch, write.epoch), eq(appStreamOutbox.seq, write.seq)),
    )
    .run()
}

/** An epoch's stream is lost (expired, erased or out of step): none of its writes go out. */
export const dropEpoch = (db: Db, key: string, epoch: number): void => {
  db.delete(appStreamOutbox)
    .where(and(eq(appStreamOutbox.stream, key), eq(appStreamOutbox.epoch, epoch)))
    .run()
}

/** Forgets every stream and write (the agent is being erased; the streams themselves are erased first). */
export const forgetStreams = (db: Db): void => {
  db.transaction((tx) => {
    tx.delete(appStreamOutbox).run()
    tx.delete(appStreams).run()
  })
}
