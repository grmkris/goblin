import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { CreateWorkspace, UpdateWorkspace, WorkspaceId, WorkspaceView } from '../account.ts'
import { API_ERRORS } from './errors.ts'

/**
 * The signed-in person's workspaces (ADR 0089), served by the Worker. Paths are relative to the API's `/api` prefix; a
 * workspace that is not theirs is not found.
 *
 * - `list`: `GET /api/workspaces`, every workspace the person belongs to, oldest membership first. A person with none
 *   is given one first, named after them; asking again finds that same one.
 * - `create`: `POST /api/workspaces`, 201 with a new workspace, the person its owner.
 * - `update`: `PATCH /api/workspaces/:workspaceId` renames it or changes its slug, for its owner or an admin. Links that
 *   used the old slug stop working; keys and MCP clients do not use it.
 * - `delete`: `DELETE /api/workspaces/:workspaceId`, for its owner: its agent is erased first, then its keys, its
 *   members' OAuth consents to it and its memberships.
 * - `select`: `POST /api/workspaces/:workspaceId/select` chooses the workspace an OAuth client's sign-in in progress is
 *   for (the consent page's choice); it changes nothing else.
 */
export class WorkspacesGroup extends HttpApiGroup.make('workspaces').add(
  HttpApiEndpoint.get('list', '/workspaces', { success: Schema.Array(WorkspaceView), error: API_ERRORS }),
  HttpApiEndpoint.post('create', '/workspaces', {
    payload: CreateWorkspace,
    success: WorkspaceView.pipe(HttpApiSchema.status(201)),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.patch('update', '/workspaces/:workspaceId', {
    params: { workspaceId: WorkspaceId },
    payload: UpdateWorkspace,
    success: WorkspaceView,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('delete', '/workspaces/:workspaceId', {
    params: { workspaceId: WorkspaceId },
    success: Schema.Struct({ deleted: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('select', '/workspaces/:workspaceId/select', {
    params: { workspaceId: WorkspaceId },
    success: Schema.Struct({ selected: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
