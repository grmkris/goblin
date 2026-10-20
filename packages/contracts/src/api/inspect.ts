import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChatId, EntryId, OperationId } from '../ids.ts'
import { InspectDetails, InspectFlows, InspectProblems, InspectTurns, TurnTimeline } from '../inspect.ts'
import { FlowName } from '../telemetry.ts'
import { ApiErrors } from './errors.ts'
import { ApiKeyScope } from './keys.ts'

/** Which message of the chat: the operation that sent it, or the entry it shows as. */
const DetailsQuery = Schema.Union([Schema.Struct({ operation: OperationId }), Schema.Struct({ entry: EntryId })])

/** `?since=`: epoch milliseconds; the last day without it. */
const Since = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
/** `?limit=`: 1 to 100. */
const Limit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
)

/**
 * Read-only inspection of the agent's conversations and runs (ADR 0024), for the owner's own UI and, content-free and
 * within its reach, for a server's API key with the `inspect` scope (ADR 0084). Paths are relative to the API's `/api`
 * prefix; /mcp's inspection tools for an OAuth client read the same through the agent's raw `/inspect` route.
 *
 * - `details`: `GET /api/conversations/:id/details?operation=…` or `?entry=…`, what happened behind one message of the
 *   chat: the timeline of its operation (its turn when it ran one) and the operations related to it. The path sits
 *   with the conversation routes, whose `:id` is the chat id; the endpoint belongs to inspection.
 * - `turns`: `GET /api/inspect/turns?conversation=&since=&limit=`, recent turns newest first, one line each.
 * - `turn`: `GET /api/inspect/turn?operation=…`, one turn end to end: its steps in order and where its time went.
 * - `problems`: `GET /api/inspect/problems?since=&limit=&all=`, recent events needing attention, newest first.
 * - `flows`: `GET /api/inspect/flows?since=&limit=&chat=&flow=`, recent conversation flow steps, newest first.
 *
 * For a key, every read sees only the run events of chats within its reach (its Topics, their threads and Persona
 * forks): a list leaves the rest out, and an operation with any event outside it is not found.
 */
export class InspectGroup extends HttpApiGroup.make('inspect')
  .add(
    HttpApiEndpoint.get('details', '/conversations/:id/details', {
      params: { id: ChatId },
      query: DetailsQuery,
      success: InspectDetails,
      error: [ApiErrors.notFound, ApiErrors.invalidInput],
    }),
    HttpApiEndpoint.get('turns', '/inspect/turns', {
      query: { conversation: Schema.optional(ChatId), since: Schema.optional(Since), limit: Schema.optional(Limit) },
      success: InspectTurns,
      error: ApiErrors.notFound,
    }),
    HttpApiEndpoint.get('turn', '/inspect/turn', {
      query: { operation: OperationId },
      success: TurnTimeline,
      error: ApiErrors.notFound,
    }),
    HttpApiEndpoint.get('problems', '/inspect/problems', {
      query: { since: Schema.optional(Since), limit: Schema.optional(Limit), all: Schema.optional(Schema.Boolean) },
      success: InspectProblems,
    }),
    HttpApiEndpoint.get('flows', '/inspect/flows', {
      query: {
        since: Schema.optional(Since),
        limit: Schema.optional(Limit),
        chat: Schema.optional(ChatId),
        flow: Schema.optional(FlowName),
      },
      success: InspectFlows,
      error: ApiErrors.notFound,
    }),
  )
  .annotateEndpoints(ApiKeyScope, 'inspect') {}
