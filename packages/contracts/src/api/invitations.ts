import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { InvitationPreview, WorkspaceView } from '../account.ts'
import { API_ERRORS } from './errors.ts'

const InvitationId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u))

/**
 * A person's invitations (ADR 0093), served by the Worker. Paths are relative to the API's `/api` prefix.
 *
 * - `mine`: `GET /api/invitations`, those still waiting for the signed-in person's address.
 * - `preview`: `GET /api/invitations/:id`, one invitation as its link shows it, with or without a session.
 * - `accept`: `POST /api/invitations/:id/accept` makes the signed-in person a member, when their address is the one it
 *   is for and it still waits; the workspace they joined.
 * - `decline`: `POST /api/invitations/:id/decline` turns it down.
 */
export class InvitationsGroup extends HttpApiGroup.make('invitations').add(
  HttpApiEndpoint.get('mine', '/invitations', { success: Schema.Array(InvitationPreview), error: API_ERRORS }),
  HttpApiEndpoint.get('preview', '/invitations/:id', {
    params: { id: InvitationId },
    success: InvitationPreview,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('accept', '/invitations/:id/accept', {
    params: { id: InvitationId },
    success: WorkspaceView,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('decline', '/invitations/:id/decline', {
    params: { id: InvitationId },
    success: Schema.Struct({ declined: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
