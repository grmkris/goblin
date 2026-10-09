import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { DecisionsBinding } from './binding.ts'
import type { Packet } from './wire.ts'

export class ClefError extends Schema.TaggedError<ClefError>()('ClefError', {
  reason: Schema.Literals(['unavailable', 'provider', 'timeout', 'format']),
}) {}
export interface ClefClient {
  readonly evaluate: (packet: Packet) => Effect.Effect<unknown, ClefError>
}
/** No REST credential in the Worker: dispatch only through the platform binding. */
export const workersClef = (binding: DecisionsBinding | undefined): ClefClient => ({
  evaluate: (data) =>
    binding === undefined
      ? Effect.fail(new ClefError({ reason: 'unavailable' }))
      : Effect.tryPromise({
          try: () =>
            binding.run('@cf/cloudflare/clef', {
              model: 'clef',
              state: data.state,
              questions: Object.fromEntries(
                Object.entries(data.questions).map(([id, question]) => [
                  id,
                  {
                    type: question.type,
                    instructions: question.instructions,
                    ...(question.type === 'noul' ? {} : { criteria: question.criteria }),
                  },
                ]),
              ),
            }),
          catch: () => new ClefError({ reason: 'provider' }),
        }).pipe(
          Effect.timeout('5 seconds'),
          Effect.catchTag('TimeoutError', () => Effect.fail(new ClefError({ reason: 'timeout' }))),
        ),
})
