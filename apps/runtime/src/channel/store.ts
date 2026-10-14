// The Telegram channel's rows: the connection whose Events carry it, the inbox cursor, how far its grant reaches and
// what goblin does with new chats, and the turns whose answers are still to send. Plain functions over the agent's
// SQLite.
import type { ChannelStatus, NewChatsDefault, TelegramReach } from '@goblin/contracts'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appChannelReplies, appTelegramChannel } from '../storage/schema.ts'
import { dropHeld, routeRow } from './routes.ts'

type Db = DrizzleSqliteDODatabase

/** The channel while it is on: the connection that carries it and how far its grant reaches. */
export type ChannelOn = NonNullable<ChannelStatus>

/** The connection that carries the channel, or null when it is off. */
export function channelStatus(db: Db): ChannelStatus {
  const row = db.select().from(appTelegramChannel).get()
  if (row === undefined) return null
  return {
    connectionId: row.connectionId,
    enabledAt: row.enabledAt,
    transport: 'events',
    reach: row.reach,
    ...(row.widenUrl === null ? {} : { widenUrl: row.widenUrl }),
    newChats: row.newChats,
    ...(row.ended ? { ended: true } : {}),
  }
}

/** Whether `status`'s connection still carries the channel. */
export const carries = (db: Db, status: ChannelOn): boolean => channelStatus(db)?.connectionId === status.connectionId

/** The stored inbox cursor; the inbox's start when there is none. */
export const storedCursor = (db: Db): string => db.select().from(appTelegramChannel).get()?.inboxCursor ?? ''

/** The inbox cursor, while the channel is on. */
export const inboxCursor = (db: Db): string | undefined => db.select().from(appTelegramChannel).get()?.inboxCursor

/** Moves the inbox cursor to `cursor`, while `status`'s connection still carries the channel. */
export function checkpoint(db: Db, status: ChannelOn, cursor: string): void {
  db.update(appTelegramChannel)
    .set({ inboxCursor: cursor })
    .where(eq(appTelegramChannel.connectionId, status.connectionId))
    .run()
}

/** How far a grant reaches: every chat, or the DM alone with the URL that widens it. */
export type Reach = { readonly reach: TelegramReach; readonly widenUrl?: string }

/**
 * `connectionId`'s Events carry the channel from `cursor`, with the grant reaching `reach`; this row fences every older
 * cursor writer, and the chat list is read again at the next pull. What goblin does with new chats stays as it was.
 */
export function enableEvents(db: Db, connectionId: string, cursor: string, now: number, reach: Reach): ChannelStatus {
  const row = {
    id: 1,
    connectionId,
    inboxCursor: cursor,
    enabledAt: now,
    reach: reach.reach,
    widenUrl: reach.widenUrl ?? null,
    syncDue: true,
    ended: false,
  }
  db.insert(appTelegramChannel).values(row).onConflictDoUpdate({ target: appTelegramChannel.id, set: row }).run()
  return channelStatus(db)
}

/** How far the grant reaches now (a widened grant reaches every chat); its Events run again. */
export function setReach(db: Db, reach: Reach): void {
  db.update(appTelegramChannel)
    .set({ reach: reach.reach, widenUrl: reach.widenUrl ?? null, ended: false })
    .run()
}

/** The server ended the channel's Events and goblin could not subscribe again. */
export function markEnded(db: Db): void {
  db.update(appTelegramChannel).set({ ended: true }).run()
}

/**
 * What goblin does with a chat it has not seen, while the channel is on: its settings revision moves on. The setting
 * before and after; none while the channel is off.
 */
export function setNewChats(
  db: Db,
  newChats: NewChatsDefault,
): { readonly before: NewChatsDefault; readonly revision: number } | undefined {
  return db.transaction(() => {
    const row = db.select().from(appTelegramChannel).get()
    if (row === undefined) return undefined
    db.update(appTelegramChannel)
      .set({ newChats, settingsRevision: sql`${appTelegramChannel.settingsRevision} + 1` })
      .run()
    return { before: row.newChats, revision: row.settingsRevision + 1 }
  })
}

/**
 * The revision a Telegram receipt's target is at now (ADR 0055): a route's (`<chat>:<thread>`) or the new-chats
 * default's; none when it is gone or the channel is off.
 */
export function telegramRevision(db: Db, kind: string, target: string): number | undefined {
  if (kind === 'telegram.default')
    return db.select({ revision: appTelegramChannel.settingsRevision }).from(appTelegramChannel).get()?.revision
  const split = target.lastIndexOf(':')
  return routeRow(db, target.slice(0, split), Number(target.slice(split + 1)))?.revision
}

/** The server's chat list is to be read again (a chat changed) at the next pull. */
export function markSyncDue(db: Db): void {
  db.update(appTelegramChannel).set({ syncDue: true }).run()
}

/** Whether the chat list is to be read again; read, it is not. */
export function takeSyncDue(db: Db): boolean {
  return db.transaction(() => {
    const due = db.select({ syncDue: appTelegramChannel.syncDue }).from(appTelegramChannel).get()?.syncDue === true
    if (due) db.update(appTelegramChannel).set({ syncDue: false }).run()
    return due
  })
}

/** Turns the channel off; answers still to send and held messages are dropped, the routes stay. */
export function disableChannel(db: Db): void {
  db.delete(appTelegramChannel).run()
  db.delete(appChannelReplies).run()
  dropHeld(db)
}

/**
 * Where a turn's answer goes back to (ADR 0055): the goblin chat it ran in (none for main), the Telegram chat and topic
 * it came from, and the Persona that answers it instead of goblin.
 */
export type ReplyTarget = {
  readonly chatId?: string
  readonly tgChat: string
  readonly tgThread: number
  readonly personaId?: number
}

/** A turn of main answered back in the DM: what a reply carried before routes. */
const MAIN_DM: ReplyTarget = { tgChat: 'dm', tgThread: 0 }

/** Remembers a turn whose answer goes to Telegram at `target`, while the channel is on; whether it did. */
export function trackReply(db: Db, operationId: string, now: number, target: ReplyTarget = MAIN_DM): boolean {
  if (channelStatus(db) === null) return false
  db.insert(appChannelReplies)
    .values({
      operationId,
      chatId: target.chatId ?? null,
      tgChat: target.tgChat,
      tgThread: target.tgThread,
      personaId: target.personaId ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run()
  return true
}

/** The turns whose answers are still to send, oldest first. */
export const pendingReplies = (db: Db) =>
  db
    .select()
    .from(appChannelReplies)
    .where(isNull(appChannelReplies.deliveredAt))
    .orderBy(asc(appChannelReplies.createdAt))
    .all()

/** A turn's answer went to Telegram at `now`. */
export function markDelivered(db: Db, operationId: string, now: number): void {
  db.update(appChannelReplies)
    .set({ deliveredAt: now })
    .where(and(eq(appChannelReplies.operationId, operationId), isNull(appChannelReplies.deliveredAt)))
    .run()
}
