// The Telegram channel's rows: the connection that carries it (its Events or the doorbell), the inbox cursor, the sealed
// doorbell secret, and the turns whose answers are still to send. Plain functions over the agent's SQLite.
import type { ChannelStatus, NewChatsDefault, TelegramReach } from '@goblin/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appChannel, appChannelReplies, appTelegramChannel } from '../storage/schema.ts'
import { dropHeld } from './routes.ts'

type Db = DrizzleSqliteDODatabase

/** The channel while it is on: the connection that carries it and how. */
export type ChannelOn = NonNullable<ChannelStatus>

/** The connection that carries the channel, or null when it is off. */
export function channelStatus(db: Db): ChannelStatus {
  const events = db.select().from(appTelegramChannel).get()
  if (events !== undefined)
    return {
      connectionId: events.connectionId,
      enabledAt: events.enabledAt,
      transport: 'events',
      reach: events.reach,
      ...(events.widenUrl === null ? {} : { widenUrl: events.widenUrl }),
      newChats: events.newChats,
    }
  const row = db
    .select({ connectionId: appChannel.connectionId, enabledAt: appChannel.enabledAt })
    .from(appChannel)
    .get()
  return row === undefined ? null : { ...row, transport: 'doorbell' }
}

/** Whether `status` still carries the channel. */
export function carries(db: Db, status: ChannelOn): boolean {
  const current = channelStatus(db)
  return current?.connectionId === status.connectionId && current?.transport === status.transport
}

/** The inbox cursor stored for either transport, the Events one first; the inbox's start when there is none. */
export const storedCursor = (db: Db): string =>
  db.select().from(appTelegramChannel).get()?.inboxCursor ?? db.select().from(appChannel).get()?.cursor ?? ''

/** The inbox cursor `transport` keeps, while it carries the channel. */
export const inboxCursor = (db: Db, transport: ChannelOn['transport']): string | undefined =>
  transport === 'events'
    ? db.select().from(appTelegramChannel).get()?.inboxCursor
    : db.select().from(appChannel).get()?.cursor

/** Moves `status`'s inbox cursor to `cursor`, while the same connection still carries the channel. */
export function checkpoint(db: Db, status: ChannelOn, cursor: string): void {
  if (status.transport === 'events')
    db.update(appTelegramChannel)
      .set({ inboxCursor: cursor })
      .where(eq(appTelegramChannel.connectionId, status.connectionId))
      .run()
  else if (channelStatus(db)?.transport === 'doorbell')
    db.update(appChannel).set({ cursor }).where(eq(appChannel.connectionId, status.connectionId)).run()
}

/**
 * `connectionId`'s Events carry the channel from `cursor`, with the grant reaching `reach` (the DM only, with the URL
 * that widens it); this row fences every older cursor writer. What goblin does with new chats stays as the owner set it.
 */
export function enableEvents(
  db: Db,
  connectionId: string,
  cursor: string,
  now: number,
  reach: { readonly reach: TelegramReach; readonly widenUrl?: string } = { reach: 'dm' },
): ChannelStatus {
  const row = {
    id: 1,
    connectionId,
    inboxCursor: cursor,
    enabledAt: now,
    reach: reach.reach,
    widenUrl: reach.widenUrl ?? null,
  }
  db.insert(appTelegramChannel).values(row).onConflictDoUpdate({ target: appTelegramChannel.id, set: row }).run()
  return channelStatus(db)
}

/** What goblin does with a chat it has not seen, while the channel is on; whether it is on. */
export function setNewChats(db: Db, newChats: NewChatsDefault): boolean {
  if (db.select().from(appTelegramChannel).get() === undefined) return false
  db.update(appTelegramChannel).set({ newChats }).run()
  return true
}

/** `connectionId`'s doorbell carries the channel from `cursor`, signed with the `secret` sealed under the credential key. */
export function enableDoorbell(
  db: Db,
  input: {
    readonly connectionId: string
    readonly cursor: string
    readonly secret: string
    readonly enabledAt: number
  },
): ChannelStatus {
  const row = { id: 1, ...input }
  db.insert(appChannel).values(row).onConflictDoUpdate({ target: appChannel.id, set: row }).run()
  db.delete(appTelegramChannel).run()
  return channelStatus(db)
}

/** Turns the channel off; answers still to send and held messages are dropped, the routes stay. */
export function disableChannel(db: Db): void {
  db.delete(appTelegramChannel).run()
  db.delete(appChannel).run()
  db.delete(appChannelReplies).run()
  dropHeld(db)
}

/** The doorbell secret, sealed, while the doorbell carries the channel. */
export function sealedSecret(db: Db): string | undefined {
  if (channelStatus(db)?.transport === 'events') return undefined
  return db.select({ secret: appChannel.secret }).from(appChannel).get()?.secret
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
