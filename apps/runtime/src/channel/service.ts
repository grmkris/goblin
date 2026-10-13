import type { ChannelStatus, NewChatsDefault } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { ChannelPorts, DeliveredReply } from './channel.ts'
import type { RouteChoice, RouteRow } from './routes.ts'
import type { Reach } from './store.ts'
import type { ChannelCall } from './tools.ts'

/**
 * The Telegram channel (ADRs 0009, 0055): the one connection the owner chose to carry Telegram, its inbox cursor, how
 * far its grant reaches, where each chat goes and the answers still to send. Instants are epoch seconds. Built once, by start
 * step 11 (`telegramChannel`).
 */
export class Channel extends Context.Service<
  Channel,
  {
    /** The connection that carries the channel, or null when it is off. */
    readonly status: Effect.Effect<ChannelStatus>
    /**
     * Where to start reading `connectionId`'s inbox (`chats` says which chats it reads): the stored cursor when it already
     * carries the channel, else its end.
     */
    readonly startCursor: (
      connectionId: string,
      call: ChannelCall,
      chats?: { readonly chat?: string },
    ) => Effect.Effect<string, AppError>
    /**
     * Carries the channel through `connectionId`'s Events, from `inboxCursor`, with the grant reaching `reach`. Only
     * after the leases are confirmed.
     */
    readonly enableEvents: (
      connectionId: string,
      inboxCursor: string,
      now: number,
      reach: Reach,
    ) => Effect.Effect<ChannelStatus>
    /** How far the grant reaches now. */
    readonly setReach: (reach: Reach) => Effect.Effect<void>
    /** A chat changed: the server's chat list is read again at the next pull. */
    readonly chatsChanged: Effect.Effect<void>
    /** The server ended the channel's Events and they could not be subscribed again: the owner must look. */
    readonly ended: Effect.Effect<void>
    /** Turns the channel off; answers still to send and held messages are dropped, the routes stay. */
    readonly disable: Effect.Effect<void>
    /** Remembers a turn of main whose answer goes to Telegram's DM. */
    readonly track: (operationId: string, now: number) => Effect.Effect<void>
    /** Reads the inbox from the cursor and routes each new message from the owner, one pull at a time. */
    readonly pull: (ports: ChannelPorts, now: number) => Effect.Effect<void, AppError>
    /**
     * Sets where `key`'s chat or topic goes, as `by` chose it, and delivers what waited for it, between pulls. The row
     * before and after; none when goblin has never seen that chat or topic.
     */
    readonly route: (
      ports: ChannelPorts,
      key: { readonly chat: string; readonly thread: number },
      choice: RouteChoice,
      by: 'owner' | 'agent',
      now: number,
    ) => Effect.Effect<{ readonly before: RouteRow; readonly after: RouteRow } | undefined, AppError>
    /** What goblin does with a chat it has not seen; false while the channel is off. */
    readonly newChats: (value: NewChatsDefault) => Effect.Effect<boolean>
    /** Sends every answer that is ready, telling `delivered` about each; true while some are still running. */
    readonly deliver: (
      ports: ChannelPorts,
      now: number,
      delivered?: (reply: DeliveredReply) => Effect.Effect<void>,
    ) => Effect.Effect<boolean, AppError>
  }
>()('goblin/channel/Channel') {}
