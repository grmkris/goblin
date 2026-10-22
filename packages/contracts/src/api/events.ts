import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import {
  EventsPolled,
  EventsSubscribed,
  PollEvents,
  PublishedEvents,
  SubscribeEvents,
  UnsubscribeEvents,
} from '../published-events.ts'
import { ApiErrors } from './errors.ts'
import { GrantsResident } from './resident.ts'
import { EndpointScope } from './scope.ts'

/**
 * The MCP Events goblin publishes (ADR 0112, docs/architecture/published-events.md): one event, `conversation.updated`,
 * as signed webhook wake-ups or a poll. Paths are relative to the API's `/api` prefix; `/mcp` serves the same as
 * `events/list`, `events/subscribe`, `events/unsubscribe` and `events/poll`, each calling its endpoint here. Every one
 * takes the `conversations` scope and never grants resident authority; a key sees only its own rooms' chats.
 *
 * - `list`: `GET /api/events`, the events offered.
 * - `subscribe`: `POST /api/events/subscribe`, a lease on webhook deliveries to an https URL, verified by a signed
 *   challenge the URL must echo; subscribing again renews it.
 * - `unsubscribe`: `POST /api/events/unsubscribe`, the lease of that name, those arguments and that URL ends.
 * - `poll`: `POST /api/events/poll`, the occurrences after a cursor; none for `null`, which answers where now is.
 */
export class EventsGroup extends HttpApiGroup.make('events')
  .add(
    HttpApiEndpoint.get('list', '/events', { success: PublishedEvents }),
    HttpApiEndpoint.post('subscribe', '/events/subscribe', {
      payload: SubscribeEvents,
      success: EventsSubscribed,
      error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.conflict],
    }),
    HttpApiEndpoint.post('unsubscribe', '/events/unsubscribe', {
      payload: UnsubscribeEvents,
      success: Schema.Struct({}),
      error: [ApiErrors.notFound, ApiErrors.invalidInput],
    }),
    HttpApiEndpoint.post('poll', '/events/poll', {
      payload: PollEvents,
      success: EventsPolled,
      error: [ApiErrors.notFound, ApiErrors.invalidInput],
    }),
  )
  .annotateEndpoints(EndpointScope, 'conversations')
  .annotateEndpoints(GrantsResident, false) {}
