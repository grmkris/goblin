import type { AguiEvent } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'
import type { AppError } from '../http/errors.ts'
import type { RunTarget } from './run.ts'

/** One reader's connection to a chat's stream. */
export type ChatStream = {
  /** Its opening (`MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT`, the run in flight), then each batch as the chat goes on. */
  readonly batches: Stream.Stream<readonly AguiEvent[]>
  /**
   * Aborted when the producer lets the reader go (it fell too far behind, or it was connected for fifteen minutes): its
   * connection ends then, whether its client still reads or not, and the reader connects again for a fresh opening.
   */
  readonly released: AbortSignal
}

/**
 * Each chat's AG-UI stream (docs/architecture/streams.md), produced by the agent for the readers connected to it
 * (`layers/streams.ts`): nothing is kept for a chat nobody reads.
 */
export class Streams extends Context.Service<
  Streams,
  {
    /**
     * A reader joins the chat's stream: answered once its opening is in its batches, or failed before anything is read
     * when the chat cannot be followed (`Conflict` `stream_busy` past the readers a chat or the agent takes, Pi's
     * failure). Ending its batches lets go of the chat.
     */
    readonly watch: (chat: string) => Effect.Effect<ChatStream, AppError>
  }
>()('goblin/streams/Streams') {}

/**
 * One send's run as AG-UI events (ADR 0111): `POST …/messages` asked for server-sent events. Each follows the chat with
 * a watch of its own, opened before the send is admitted, and ends with the run's end (`streams/run.ts`).
 */
export class RunStreams extends Context.Service<
  RunStreams,
  {
    /**
     * Admits the send (`admit`) and answers its run's events: what the run that took it does, then its end, after which
     * the stream ends. Refused before anything is admitted past the run streams the agent takes (`Conflict`
     * `stream_busy`); `admit`'s failure is the request's.
     */
    readonly follow: <E, R>(
      target: RunTarget,
      admit: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<Stream.Stream<readonly AguiEvent[]>, E | AppError, R>
  }
>()('goblin/streams/RunStreams') {}
