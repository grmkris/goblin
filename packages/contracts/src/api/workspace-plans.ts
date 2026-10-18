import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { WorkspacePlanDecision, WorkspacePlanId, WorkspacePlanPage, WorkspacePlanView } from '../workspace-plans.ts'

/** The authenticated owner's review and activation of a composition proposed in chat. */
export class WorkspacePlansGroup extends HttpApiGroup.make('workspacePlans').add(
  HttpApiEndpoint.get('list', '/workspace-plans', { success: WorkspacePlanPage }),
  HttpApiEndpoint.get('get', '/workspace-plans/:id', { params: { id: WorkspacePlanId }, success: WorkspacePlanView }),
  HttpApiEndpoint.post('prepare', '/workspace-plans/:id/prepare', {
    params: { id: WorkspacePlanId },
    payload: WorkspacePlanDecision,
    success: WorkspacePlanView,
  }),
  HttpApiEndpoint.post('apply', '/workspace-plans/:id/apply', {
    params: { id: WorkspacePlanId },
    payload: WorkspacePlanDecision,
    success: WorkspacePlanView,
  }),
) {}
