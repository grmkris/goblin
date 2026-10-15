import * as Effect from 'effect/Effect'
import type { AppError } from '../../http/errors.ts'
import type { Events } from '../service.ts'

/** What the static skills consumer reaches. Sources and routines register their own handlers. */
export type EventConsumerPorts = {
  /** Whether the owner takes skills from `connectionId`, and forgetting its listing (`unavailable` when it stopped). */
  readonly skills: {
    readonly enabled: (connectionId: string) => Effect.Effect<boolean, AppError>
    readonly invalidate: (connectionId: string, unavailable: boolean) => Effect.Effect<void, AppError>
  }
}

/** The static handler persists skills invalidation; it never executes event text. */
export const installEventConsumers = (
  events: Pick<Events['Service'], 'register'>,
  ports: EventConsumerPorts,
): Effect.Effect<void> =>
  events.register('skills-refresh', ({ subscription, envelope }) =>
    Effect.gen(function* () {
      if (!(yield* ports.skills.enabled(subscription.connectionId))) return
      yield* ports.skills.invalidate(subscription.connectionId, 'type' in envelope && envelope.type === 'terminated')
    }),
  )
