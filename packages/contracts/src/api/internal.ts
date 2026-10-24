import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { FilePath } from '../files.ts'
import { API_ERRORS, ApiErrors } from './errors.ts'
import { Bytes } from './stream.ts'

/**
 * The agent's internal API: what reaches the owner's agent from the Worker on behalf of someone other than the owner's
 * browser. The Worker calls it on the agent's stub after its own check (a client's bearer token, a hook's route
 * token); the browser never can, because the Worker's edge forwards only `/api/*`. The web must not import this module.
 */

/** Every internal path starts with this; no owner path does (`OwnerApi` is under `/api`). */
export const INTERNAL_PREFIX = '/internal'

/**
 * The header the Worker's edge sets on every owner request it forwards. The agent refuses an internal path that
 * carries it, so nothing the owner's session reaches is an internal endpoint, whatever its path became on the way.
 */
export const FORWARDED_HEADER = 'x-goblin-forwarded'

/**
 * Admission to every internal endpoint, run by the agent before the handler: an owner forward is refused. It never
 * grants resident authority.
 * Its implementation lives in the runtime (`http/api/middleware.ts`); its error schema is every envelope.
 */
export class InternalGate extends HttpApiMiddleware.Service<InternalGate>()('goblin/api/InternalGate', {
  error: API_ERRORS,
}) {}

/** The connection whose Events webhook a delivery came to (its id, as the hook's path names it). */
const ConnectionParam = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/** The headers an MCP Events webhook is signed and addressed with, as the sender sent them. */
const WebhookHeaders = {
  'x-mcp-subscription-id': Schema.String,
  'webhook-id': Schema.String,
  'webhook-timestamp': Schema.String,
  'webhook-signature': Schema.String,
}

/** What the agent answers the Events sender: a challenge's response (200), taken (204), ended (410) or later (503). */
export const EventWebhookResult = Schema.Struct({
  status: Schema.Literals([200, 204, 410, 503]),
  response: Schema.optionalKey(Schema.String),
})
export type EventWebhookResult = typeof EventWebhookResult.Type

/**
 * What reaches the agent besides the owner and its callers (ADR 0086). Paths are relative to the API's `/internal` prefix; every endpoint can
 * also answer the gate's failures, and `error` names the ones the endpoint itself produces.
 *
 * - `mcpEvents`: `POST /internal/mcp-events/:connectionId`, one connection's MCP Events webhook: its bytes and the
 *   headers that sign it.
 * - `linkedFile`: `GET /internal/files/linked?path=`, the owner file a file link names (ADR 0070), once the Worker has
 *   checked the link's token: its bytes as an attachment, with its type and name in the answer's headers. It needs
 *   current resident authority and never grants it.
 */
export class InboundGroup extends HttpApiGroup.make('inbound').add(
  HttpApiEndpoint.post('mcpEvents', '/mcp-events/:connectionId', {
    params: { connectionId: ConnectionParam },
    headers: WebhookHeaders,
    payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    success: EventWebhookResult,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('linkedFile', '/files/linked', {
    query: { path: FilePath },
    success: Bytes,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.conflict],
  }),
) {}

/**
 * Who a published Events lease belongs to (ADR 0112), as the Worker names one whose access it is about to end: an
 * OAuth client acting for a person, or an installed app (ADR 0118).
 */
export const LeaseHolder = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('client'),
    clientId: Schema.String.check(Schema.isPattern(/^[\w.:-]{1,200}$/u)),
    user: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
  }),
  // An installed app (ADR 0118), by its installation: its grant's id.
  Schema.Struct({
    kind: Schema.Literal('app'),
    installationId: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
  }),
])
export type LeaseHolder = typeof LeaseHolder.Type

/**
 * The Events goblin publishes, as the Worker ends them (ADR 0112).
 *
 * - `terminate`: `POST /internal/publish/terminate`, before an app is uninstalled or an OAuth client revoked, or
 *   either's grant narrowed: every lease of `holder` ends, its pending deliveries are dropped and one `terminated`
 *   control goes to each. Answers how many leases it ended.
 */
export class PublishGroup extends HttpApiGroup.make('publish').add(
  HttpApiEndpoint.post('terminate', '/publish/terminate', {
    payload: Schema.Struct({ holder: LeaseHolder }),
    success: Schema.Struct({ terminated: Schema.Int }),
  }),
) {}

/** The agent's internal API, served by the agent beside `OwnerApi` and called only by the Worker. */
export class InternalApi extends HttpApi.make('goblin-internal')
  .add(InboundGroup, PublishGroup)
  .prefix(INTERNAL_PREFIX)
  .middleware(InternalGate) {}
