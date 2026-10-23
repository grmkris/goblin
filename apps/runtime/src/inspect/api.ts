import { OwnerApi } from '@goblin/contracts/api'
import type { TurnTimeline } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import type { TraceData } from 'effect/observability/OtlpTracer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type { AppError } from '../http/errors.ts'
import { inspectReach, reachesChat } from '../grants/policy.ts'
import { Inspection, type Reach, detailsInput } from './service.ts'

/**
 * `read` with the request credential's reach (ADRs 0084, 0114); without one for a member's session or a credential that
 * reaches every Topic.
 */
const within = <A, E, R>(
  read: (inspection: Inspection['Service'], reach: Reach | undefined) => Effect.Effect<A, E, R>,
) => Effect.flatMap(inspectReach, (reach) => Inspection.use((inspection) => read(inspection, reach)))

/**
 * The `inspect` group (ADRs 0024, 0086). Owner admission has already admitted the request (a credential's grant holds
 * `inspect`, ADR 0114). `details` reads the operation behind one message: the one the query names, or the one whose
 * answer or tool result the chat's entry is. A credential reads only within its grant's reach (ADR 0084): the
 * conversations of the Topics it reaches, and their runs.
 */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) =>
  handlers
    .handle('conversations', () =>
      within((inspection, reach) =>
        Effect.map(inspection.conversations, ({ conversations }) => ({
          conversations: reach === undefined ? conversations : conversations.filter((view) => reach.chat(view.id)),
        })),
      ),
    )
    .handle('conversation', ({ query }) =>
      Effect.andThen(
        reachesChat(query.conversation),
        Inspection.use((inspection) => inspection.conversation(query)),
      ),
    )
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
