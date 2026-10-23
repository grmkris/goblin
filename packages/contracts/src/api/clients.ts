import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { InboundClient } from '../account.ts'
import { API_ERRORS } from './errors.ts'

/** A registered client's id in a path. */
const ClientId = Schema.String.check(Schema.isPattern(/^[\w.-]{1,200}$/u))

/**
 * The MCP clients a person let use goblin (ADRs 0024, 0097), served by the Worker for their session without waking an
 * agent. Paths are relative to the API's `/api` prefix. Each can answer any `AppError` envelope (`API_ERRORS`), the
 * edge's admission refusals among them.
 *
 * - `list`: `GET /api/clients`, every client with a standing consent, newest first, with its grant and the workspaces
 *   it reaches now. Its grant's terms are read and set in the `grants` group (`GET /api/clients/:clientId/terms`,
 *   `PUT /api/clients/:clientId/grant`, ADR 0114).
 * - `revoke`: `DELETE /api/clients/:clientId` ends that client's access at once: its grant is revoked, its consent goes
 *   and its refresh tokens are revoked. Other people who use the same client keep theirs.
 */
export class ClientsGroup extends HttpApiGroup.make('clients').add(
  HttpApiEndpoint.get('list', '/clients', { success: Schema.Array(InboundClient), error: API_ERRORS }),
  HttpApiEndpoint.delete('revoke', '/clients/:clientId', {
    params: { clientId: ClientId },
    success: Schema.Struct({ revoked: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
