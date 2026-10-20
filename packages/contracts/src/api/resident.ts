import * as Context from 'effect/Context'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ResidentStatus } from '../agent.ts'
import { ResidentChange } from '../mcp.ts'

/**
 * Whether owner admission grants resident authority before the endpoint runs (`OwnerAdmission` in `owner.ts`): the
 * owner's first signed-in request grants it, and it lasts until they revoke it (ADR 0088). Every owner request grants it
 * except changing it, since re-enabling grants on its own. An endpoint that must not grant is annotated `false`.
 */
export const GrantsResident = Context.Reference<boolean>('goblin/api/GrantsResident', { defaultValue: () => true })

/**
 * Resident authority (ADR 0003, 0088): what lets the agent act without a live browser session, until the owner revokes
 * it. Paths are relative to the API's `/api` prefix.
 *
 * - `status`: `GET /api/agent/resident`, as it is now, after admission granted it.
 * - `set`: `POST /api/agent/resident` revokes it (Events subscriptions first) or enables it again; admission does not
 *   grant it first.
 */
export class ResidentGroup extends HttpApiGroup.make('resident').add(
  HttpApiEndpoint.get('status', '/agent/resident', { success: ResidentStatus }),
  HttpApiEndpoint.post('set', '/agent/resident', { payload: ResidentChange, success: ResidentStatus }).annotate(
    GrantsResident,
    false,
  ),
) {}
