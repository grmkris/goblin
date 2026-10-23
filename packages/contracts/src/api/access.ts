import * as Context from 'effect/Context'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { AccessSummary, type Need } from '../grants.ts'

/**
 * What an owner endpoint needs of a credential (a server's API key, or an OAuth client acting for a person): a level,
 * and an extra when it takes one (`grants.ts`). An endpoint without one is reached by no credential, only by a member's
 * session (whose role `EndpointRole` checks). A handler checks the reach of what it touches itself.
 */
export const EndpointAccess = Context.Reference<Need | undefined>('goblin/api/EndpointAccess', {
  defaultValue: () => undefined,
})

/**
 * The calling credential's own grant. Paths are relative to the API's `/api` prefix.
 *
 * - `read`: `GET /api/access`, the credential's grant as `AccessSummary`: its terms, when it ends and its widening link,
 *   which `/mcp` answers as `access_read`. A member's session has no grant and is refused (`credential`).
 */
export class AccessGroup extends HttpApiGroup.make('access').add(
  HttpApiEndpoint.get('read', '/access', { success: AccessSummary }).annotate(EndpointAccess, { level: 'read' }),
) {}
