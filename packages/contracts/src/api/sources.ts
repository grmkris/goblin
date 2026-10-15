import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import {
  SourceId,
  SourcePage,
  SourceProposal,
  SourceRevision,
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
 * - `list`: `GET /api/sources`, every Source with the conversations waiting for a route.
 * - `propose`: `POST /api/sources`, 201 with the proposal (the same operation finds it again); nothing runs until the
 *   owner confirms its revision.
 * - `confirm`, `refuse`: `POST /api/sources/:id/confirm|refuse` with the exact revision; confirming grants its event and
 *   tools, subscribes and binds it to the connection's endpoint and those grants. A stale revision is a conflict; the
 *   connection carrying Telegram is refused (`telegram_on`) until the channel is turned off.
 * - `routes`: `GET /api/sources/:id/routes`, every conversation it has seen and where it goes.
 * - `route`: `PUT /api/sources/:id/routes` sets where one conversation goes and delivers what it held, with an
 *   organizing receipt the owner can undo.
 * - `pause`, `resume`: `POST /api/sources/:id/pause|resume`; resuming binds it again to the endpoint and grants now.
 * - `remove`: `DELETE /api/sources/:id` ends its subscription and forgets it, its routes and what it held.
 */
export class SourcesGroup extends HttpApiGroup.make('sources').add(
  HttpApiEndpoint.get('list', '/sources', { success: SourcePage }),
  HttpApiEndpoint.post('propose', '/sources', {
    payload: SourceProposal,
    success: SourceView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
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
