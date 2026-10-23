import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ClientGrantTerms, ConsentTerms, WidenRequest, WidenResult } from '../grants.ts'
import { API_ERRORS } from './errors.ts'

/** A grant's id in a path: a key's id, or `cg_` and a client grant's own. */
const GrantId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))
/** A registered client's id in a path. */
const ClientId = Schema.String.check(Schema.isPattern(/^[\w.-]{1,200}$/u))

/**
 * Grants, as the person who approves them sees them (`grants.ts`), served by the Worker for their session without
 * waking an agent. Paths are relative to the API's `/api` prefix. Each can answer any `AppError` envelope.
 *
 * - `terms`: `GET /api/grants/:id/terms`, what the widening page shows for a live grant the person may approve: its
 *   current terms, summary and what may be chosen.
 * - `widen`: `PUT /api/grants/:id` saves the terms the person approved for it, widened or narrowed; the body names the
 *   same grant.
 * - `clientTerms`: `GET /api/clients/:clientId/terms`, what the consent page shows for an MCP client: the default
 *   chain's terms and, once it has one, its grant's.
 * - `clientGrant`: `PUT /api/clients/:clientId/grant` saves the person's terms for that client, before its consent or
 *   later from Settings; a live token follows them at once.
 *
 * Not yet part of `AccountApi`: the Worker serves it once the auth store keeps grants.
 */
export class GrantsGroup extends HttpApiGroup.make('grants').add(
  HttpApiEndpoint.get('terms', '/grants/:id/terms', {
    params: { id: GrantId },
    success: ConsentTerms,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.put('widen', '/grants/:id', {
    params: { id: GrantId },
    payload: WidenRequest,
    success: WidenResult,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.get('clientTerms', '/clients/:clientId/terms', {
    params: { clientId: ClientId },
    success: ConsentTerms,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.put('clientGrant', '/clients/:clientId/grant', {
    params: { clientId: ClientId },
    payload: ClientGrantTerms,
    success: WidenResult,
    error: API_ERRORS,
  }),
) {}
