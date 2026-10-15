// Undo of a Source route's organizing receipt (ADR 0033): restore its previous state only while nothing
// has touched the route since the recorded change.
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Conflict, InvalidInput } from '../http/errors.ts'

/**
 * Puts a route back as `receipt` found it: `restore` takes its `before`, decoded with `snapshot`. Refused as `touched`
 * (409) once the route's revision now (`current`) is not the one the change left, and as `InvalidInput` for a snapshot
 * that does not decode.
 */
export const undoRoute = <A, E, R>(
  receipt: { readonly before: unknown; readonly afterRevision: number },
  current: number | undefined,
  snapshot: Schema.Decoder<A>,
  restore: (before: A) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    if (current !== receipt.afterRevision) return yield* new Conflict({ reason: 'touched' })
    const before = yield* Schema.decodeUnknownEffect(snapshot)(receipt.before).pipe(
      Effect.mapError(() => new InvalidInput({ reason: 'schema' })),
    )
    yield* restore(before)
  })
