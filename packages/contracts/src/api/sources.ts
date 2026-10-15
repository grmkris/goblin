import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import {
  NotifySink,
  NotifySinkView,
  SourceId,
  SourcePage,
  SourceRevision,
  SourceReplyResultChange,
  SourceRoutePick,
  SourceRouteView,
  SourceRoutes,
  SourceView,
} from '../sources.ts'
import { ApiErrors } from './errors.ts'

const params = { id: SourceId }

/**
 * The owner's Sources (ADR 0066). Paths are relative to the API's `/api` prefix; every endpoint can also answer owner
 * admission's failures, and `error` names the ones the endpoint itself produces.
 *
 * - `list`: `GET /api/sources`, every Source with the conversations waiting for a route. A Source is proposed only by
 *   the agent's `source_propose` (ADR 0068); the owner confirms or refuses its exact revision here.
 * - `confirm`, `refuse`: `POST /api/sources/:id/confirm|refuse` with the exact revision; confirming grants its event and
 *   tools, subscribes and binds it to the connection's endpoint and those grants. A stale revision is a conflict.
 * - `routes`: `GET /api/sources/:id/routes`, every conversation it has seen and where it goes.
 * - `route`: `PUT /api/sources/:id/routes` sets where one conversation goes and delivers what it held, with an
 *   organizing receipt the owner can undo.
 * - `pause`, `resume`: `POST /api/sources/:id/pause|resume`; resuming binds it again to the endpoint and grants now.
 * - `remove`: `DELETE /api/sources/:id` ends its subscription and forgets it, its routes and what it held.
 */
export class SourcesGroup extends HttpApiGroup.make('sources').add(
  HttpApiEndpoint.get('list', '/sources', { success: SourcePage }),
  HttpApiEndpoint.post('confirm', '/sources/:id/confirm', {
    params,
    payload: SourceRevision,
    success: SourceView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.forbidden, ApiErrors.upstream],
  }),
  HttpApiEndpoint.post('refuse', '/sources/:id/refuse', {
    params,
    payload: SourceRevision,
    success: SourceView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.put('replyResult', '/sources/:id/reply-result', {
    params,
    payload: SourceReplyResultChange,
    success: SourceView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('routes', '/sources/:id/routes', {
    params,
    success: SourceRoutes,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.put('route', '/sources/:id/routes', {
    params,
    payload: SourceRoutePick,
    success: SourceRouteView,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.post('pause', '/sources/:id/pause', {
    params,
    success: SourceView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('resume', '/sources/:id/resume', {
    params,
    success: SourceView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.forbidden, ApiErrors.upstream],
  }),
  HttpApiEndpoint.delete('remove', '/sources/:id', {
    params,
    success: Schema.Null,
    error: [ApiErrors.notFound],
  }),
) {}

/**
 * "Notify me via" (ADR 0066): the one tool goblin copies its notices to the owner with. Paths are relative to the API's
 * `/api` prefix.
 *
 * - `get`: `GET /api/notify-sink`, the setting with its connection's label, or null.
 * - `set`: `PUT /api/notify-sink`, on a connection the owner has and a tool it offers now; the tool is granted, as the
 *   owner chose it.
 * - `clear`: `DELETE /api/notify-sink`, answered with null; the tool's grant stays.
 */
export class NotifyGroup extends HttpApiGroup.make('notify').add(
  HttpApiEndpoint.get('get', '/notify-sink', { success: NotifySinkView }),
  HttpApiEndpoint.put('set', '/notify-sink', {
    payload: NotifySink,
    success: NotifySinkView,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.conflict, ApiErrors.upstream],
  }),
  HttpApiEndpoint.delete('clear', '/notify-sink', { success: Schema.Null }),
) {}
