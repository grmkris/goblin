import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChatId, OperationId } from '../ids.ts'
import {
  InspectConversations,
  InspectDetails,
  InspectEntries,
  InspectFlows,
  InspectProblems,
  InspectTurns,
  TurnTimeline,
} from '../inspect.ts'
import { FlowName } from '../telemetry.ts'
import { ApiErrors } from './errors.ts'
import { EndpointScope } from './scope.ts'

/** An entry id in a query. */
const Entry = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

/**
 * Which operation: `operation`, or `chat` with `entry` for the operation that wrote that entry. Any other combination
 * is invalid input.
 */
const DetailsQuery = {
  operation: Schema.optional(OperationId),
  chat: Schema.optional(ChatId),
  entry: Schema.optional(Entry),
}

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
 * Read-only inspection of the agent's conversations and runs (ADR 0024), for the owner's own UI and for the owner's
 * callers on /mcp (ADR 0086). Paths are relative to the API's `/api` prefix.
 *
 * - `conversations`: `GET /api/inspect/conversations`, every conversation the agent keeps.
 * - `conversation`: `GET /api/inspect/conversation?conversation=&before=`, a page of one conversation's entries in full.
 * - `turns`: `GET /api/inspect/turns?conversation=&since=&limit=`, recent turns newest first, one line each.
 * - `turn`: `GET /api/inspect/turn?operation=…`, one turn end to end: its steps in order and where its time went.
 * - `problems`: `GET /api/inspect/problems?since=&limit=&all=`, recent events needing attention, newest first.
 * - `flows`: `GET /api/inspect/flows?since=&limit=&chat=&flow=`, recent conversation flow steps, newest first.
 * - `details`: `GET /api/inspect/details?operation=…` or `?chat=&entry=`, what happened behind one message: its
 *   operation's timeline (its turn when it ran one) and the operations related to it.
 *
 * The two conversation reads carry words and need `transcripts`, which only an OAuth client of the owner can hold; the
 * rest are content-free and need `inspect`. A key sees only the run events of chats within its reach (ADR 0084).
 */
export class InspectGroup extends HttpApiGroup.make('inspect').add(
  HttpApiEndpoint.get('conversations', '/inspect/conversations', { success: InspectConversations }).annotate(
    EndpointScope,
    'transcripts',
  ),
  HttpApiEndpoint.get('conversation', '/inspect/conversation', {
    query: { conversation: ChatId, before: Schema.optional(Entry) },
    success: InspectEntries,
    error: ApiErrors.notFound,
  }).annotate(EndpointScope, 'transcripts'),
  HttpApiEndpoint.get('turns', '/inspect/turns', {
    query: { conversation: Schema.optional(ChatId), since: Schema.optional(Since), limit: Schema.optional(Limit) },
    success: InspectTurns,
    error: ApiErrors.notFound,
  }).annotate(EndpointScope, 'inspect'),
  HttpApiEndpoint.get('turn', '/inspect/turn', {
    query: { operation: OperationId },
    success: TurnTimeline,
    error: ApiErrors.notFound,
  }).annotate(EndpointScope, 'inspect'),
  HttpApiEndpoint.get('problems', '/inspect/problems', {
    query: { since: Schema.optional(Since), limit: Schema.optional(Limit), all: Schema.optional(Schema.Boolean) },
    success: InspectProblems,
  }).annotate(EndpointScope, 'inspect'),
  HttpApiEndpoint.get('flows', '/inspect/flows', {
    query: {
      since: Schema.optional(Since),
      limit: Schema.optional(Limit),
      chat: Schema.optional(ChatId),
      flow: Schema.optional(FlowName),
    },
    success: InspectFlows,
    error: ApiErrors.notFound,
  }).annotate(EndpointScope, 'inspect'),
  HttpApiEndpoint.get('details', '/inspect/details', {
    query: DetailsQuery,
    success: InspectDetails,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }).annotate(EndpointScope, 'inspect'),
) {}
