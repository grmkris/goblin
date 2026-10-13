import type { ChannelStatus } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from '../../http/errors.ts'
import type { Events } from '../service.ts'

/** What the static consumers reach: the Telegram channel, the pull it schedules, and the skills libraries. */
export type EventConsumerPorts = {
  /** The Telegram channel's server, or null while it is off. */
  readonly channel: Effect.Effect<ChannelStatus, AppError>
  /** Schedules the channel's pull, which also subscribes again what the server ended. */
  readonly pull: Effect.Effect<void, AppError>
  /** The server's chat list is to be read again at the next pull: a chat changed (ADR 0055). */
  readonly chatsChanged: Effect.Effect<void, AppError>
  /** Whether the owner takes skills from `connectionId`, and forgetting its listing (`unavailable` when it stopped). */
  readonly skills: {
    readonly enabled: (connectionId: string) => Effect.Effect<boolean, AppError>
    readonly invalidate: (connectionId: string, unavailable: boolean) => Effect.Effect<void, AppError>
  }
}

/** The handler of the Telegram channel's subscriptions: what tells an event the channel already takes (ADR 0041). */
export const TELEGRAM_INBOX = 'telegram-inbox'

/** Whether `name` is mygram's `chat.changed`, under either spelling. */
const isChatChanged = (name: string) => name === 'chat.changed' || name.endsWith('.chat.changed')

/**
 * Installed static handlers never execute event text; Telegram pulls the inbox (and, for a changed chat, reads the
 * server's chat list again; an ended subscription is subscribed again by the pull), Skills persist invalidation.
 */
export const installEventConsumers = (
  events: Pick<Events['Service'], 'register'>,
  ports: EventConsumerPorts,
): Effect.Effect<void> =>
  Effect.andThen(
    events.register(TELEGRAM_INBOX, ({ subscription, envelope }) =>
      Effect.gen(function* () {
        const status = yield* ports.channel
        if (status?.connectionId !== subscription.connectionId) return
        if ('name' in envelope && isChatChanged(envelope.name)) yield* ports.chatsChanged
        yield* ports.pull
      }),
    ),
    events.register('skills-refresh', ({ subscription, envelope }) =>
      Effect.gen(function* () {
        if (!(yield* ports.skills.enabled(subscription.connectionId))) return
        yield* ports.skills.invalidate(subscription.connectionId, 'type' in envelope && envelope.type === 'terminated')
      }),
    ),
  )
