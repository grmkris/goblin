// The Sources' engine (ADR 0066): a Source's messages coming in (sources/messages.ts) and its answers going back
// (sources/replies.ts), over the agent's database and ports, made once per agent by the Sources' layer.
import type { SourceRoute } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'
import { type AppError, Internal } from '../http/errors.ts'
import { turnLedger } from './delivery.ts'
import { type RouteChange, pull, route, startCursor, takeEvent } from './messages.ts'
import { deliverReplies } from './replies.ts'
import { type SourceRow, setRoute, setupOf } from './store.ts'
import type { EngineContext, EngineInput, Loaded, SourceDelivery, SourcePorts } from './types.ts'

/** `row` with its setup; `Internal` for a row whose setup goblin cannot read back. */
export const loaded = (row: SourceRow): Effect.Effect<Loaded, AppError> =>
  Effect.suspend(() => {
    const setup = setupOf(row)
    return setup === undefined
      ? Effect.fail(new Internal({ reason: 'source setup does not decode' }))
      : Effect.succeed({ row, setup })
  })

/**
 * The Sources' engine over the agent's database: reading messages, routing them and sending the answers owed. Reads,
 * pulls and route changes take one permit (`Semaphore(1)`, as the Telegram channel's do; order between Sources does
 * not matter), so a message is never held after its conversation's held messages were delivered.
 */
export const sourceEngine = (input: EngineInput) =>
  Effect.map(Semaphore.make(1), (serial) => {
    const context: EngineContext = { db: input.db, record: turnLedger(input, 'source'), wake: input.wake }
    return {
      takeEvent: (source: Loaded, event: { readonly eventId: string; readonly data: unknown }, ports: SourcePorts) =>
        serial.withPermit(takeEvent(context, source, event, ports)).pipe(Effect.withSpan('Sources.takeEvent')),
      pull: (source: Loaded, ports: SourcePorts) =>
        serial.withPermit(pull(context, source, ports)).pipe(Effect.withSpan('Sources.pull')),
      startCursor: (source: Loaded, ports: SourcePorts) =>
        startCursor(source, ports).pipe(Effect.withSpan('Sources.startCursor')),
      route: (source: Loaded, change: RouteChange, ports: SourcePorts) =>
        serial.withPermit(route(context, source, change, ports)).pipe(Effect.withSpan('Sources.route')),
      /** Puts a route back as an Undo found it, with no delivery: the row after, none for a key goblin never saw. */
      restore: (sourceId: string, key: string, target: SourceRoute) =>
        serial.withPermit(
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() => setRoute(input.db, { sourceId, key }, target, 'owner', Math.floor(now / 1000))?.after),
          ),
        ),
      deliver: (ports: SourcePorts, delivered: (delivery: SourceDelivery) => Effect.Effect<void> = () => Effect.void) =>
        deliverReplies(context, ports, delivered).pipe(Effect.withSpan('Sources.deliver')),
    }
  })

/** The Sources' engine, as `sourceEngine` makes it once per agent. */
export type SourceEngine = Effect.Success<ReturnType<typeof sourceEngine>>
