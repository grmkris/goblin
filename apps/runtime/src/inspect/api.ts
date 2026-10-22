import { OwnerApi } from '@goblin/contracts/api'
import type { TurnTimeline } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import type { TraceData } from 'effect/observability/OtlpTracer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type { AppError } from '../http/errors.ts'
import { inspectReach } from '../keys/policy.ts'
import { Inspection, type Reach, detailsInput } from './service.ts'

/** `read` with the request key's reach (ADR 0084); without one for the owner and an OAuth client of the owner. */
const within = <A, E, R>(
  read: (inspection: Inspection['Service'], reach: Reach | undefined) => Effect.Effect<A, E, R>,
) => Effect.flatMap(inspectReach, (reach) => Inspection.use((inspection) => read(inspection, reach)))

/**
 * The `inspect` group (ADRs 0024, 0086). Owner admission has already admitted the request; only a caller with
 * `transcripts` reaches the two conversation reads, which no key can hold. `details` reads the operation behind one
 * message: the one the query names, or the one whose answer or tool result the chat's entry is. A server's API key
 * reads only within its reach (ADR 0084).
 */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) =>
  handlers
    .handle('conversations', () => Inspection.use((inspection) => inspection.conversations))
    .handle('conversation', ({ query }) => Inspection.use((inspection) => inspection.conversation(query)))
    .handle('turns', ({ query }) => within((inspection, reach) => inspection.turns(query, reach)))
    .handle('turn', ({ query }) =>
      within((inspection, reach): Effect.Effect<TurnTimeline | TraceData, AppError> =>
        query.format === 'otlp' ? inspection.trace(query.operation, reach) : inspection.turn(query.operation, reach),
      ),
    )
    .handle('problems', ({ query }) => within((inspection, reach) => inspection.problems(query, reach)))
    .handle('flows', ({ query }) => within((inspection, reach) => inspection.flows(query, reach)))
    .handle('details', ({ query }) =>
      within((inspection, reach) => Effect.flatMap(detailsInput(query), (input) => inspection.details(input, reach))),
    ),
)
