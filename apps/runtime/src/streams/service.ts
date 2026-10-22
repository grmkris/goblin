import type { StreamTier } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'

/**
 * Each chat's AG-UI streams (docs/architecture/streams.md): the agent produces a chat's stream in a tier once someone
 * joined it, following Pi's events into a Durable Streams object per epoch (`layers/streams.ts`).
 */
export class Streams extends Context.Service<
  Streams,
  {
    /**
     * Joins the chat's stream in `tier`: makes its first epoch when it has none, catches it up, and answers the epoch
     * a reader reads once its stream exists. `Conflict` `streams_off` without the streams binding, `stream_starting`
     * when the stream could not be made in time.
     */
    readonly join: (chat: string, tier: StreamTier) => Effect.Effect<number, AppError>
    /** Erases every stream the agent made, each epoch of each, and forgets them (the account is being erased). */
    readonly erase: Effect.Effect<void, AppError>
  }
>()('goblin/streams/Streams') {}
