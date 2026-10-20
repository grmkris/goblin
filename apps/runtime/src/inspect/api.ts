import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { NotFound } from '../http/errors.ts'
import { inspectReach } from '../keys/policy.ts'
import { Inspection, type Reach } from './service.ts'

/** `read` with the request key's reach (ADR 0084); without one for the owner's session. */
const within = <A, E, R>(
  read: (inspection: Inspection['Service'], reach: Reach | undefined) => Effect.Effect<A, E, R>,
) => Effect.flatMap(inspectReach, (reach) => Inspection.use((inspection) => read(inspection, reach)))

/**
 * The `inspect` group (ADR 0024). Owner admission has already admitted the request. `details` reads the operation
 * behind one message of the chat: the one the query names, or the one whose answer or tool result the entry is. A
 * server's API key reads only within its reach, and its chat in the path must be within it too (ADR 0084).
 */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) =>
  handlers
    .handle('details', ({ params, query }) =>
      within((inspection, reach) =>
        reach !== undefined && !reach.chat(params.id)
          ? Effect.fail(new NotFound({ what: 'conversation' }))
          : inspection.details('operation' in query ? query : { chat: params.id, entry: query.entry }, reach),
      ),
    )
    .handle('turns', ({ query }) => within((inspection, reach) => inspection.turns(query, reach)))
    .handle('turn', ({ query }) => within((inspection, reach) => inspection.turn(query.operation, reach)))
    .handle('problems', ({ query }) => within((inspection, reach) => inspection.problems(query, reach)))
    .handle('flows', ({ query }) => within((inspection, reach) => inspection.flows(query, reach))),
)
