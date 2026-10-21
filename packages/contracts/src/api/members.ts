import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { InvitationView, InviteMembers, InviteSent, MemberView, UpdateMember } from '../account.ts'
import { API_ERRORS } from './errors.ts'

const UserId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))
const InvitationId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u))

/**
 * A workspace's members and invitations (ADR 0093), served by the Worker under `/w/<slug>`. Paths are relative to the
 * API's `/api` prefix. Every member reads the members; owners and admins invite and remove, and only an owner changes
 * a role.
 *
 * - `list`: `GET /api/members`, every member, owners first.
 * - `update`: `PATCH /api/members/:userId`, a member's new role. Only an owner makes or unmakes an owner, and the last
 *   owner stays one.
 * - `remove`: `DELETE /api/members/:userId` ends a membership (an admin's or an owner's only by an owner); the last
 *   owner is never removed.
 * - `leave`: `POST /api/members/leave` ends the caller's own; the last owner cannot leave.
 * - `invitations`: `GET /api/members/invitations`, those still waiting, newest first.
 * - `invite`: `POST /api/members/invitations`, one invitation per address for seven days, mailed with its link; an
 *   address already a member is a conflict, one already invited gets a fresh invitation in place of the old.
 * - `cancel`: `DELETE /api/members/invitations/:id` withdraws one.
 * - `resend`: `POST /api/members/invitations/:id/resend` mails it again, for seven days from now.
 */
export class MembersGroup extends HttpApiGroup.make('members').add(
  HttpApiEndpoint.get('list', '/members', { success: Schema.Array(MemberView), error: API_ERRORS }),
  HttpApiEndpoint.patch('update', '/members/:userId', {
    params: { userId: UserId },
    payload: UpdateMember,
    success: MemberView,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('remove', '/members/:userId', {
    params: { userId: UserId },
    success: Schema.Struct({ removed: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('leave', '/members/leave', {
    success: Schema.Struct({ left: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.get('invitations', '/members/invitations', {
    success: Schema.Array(InvitationView),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('invite', '/members/invitations', {
    payload: InviteMembers,
    success: Schema.Array(InviteSent).pipe(HttpApiSchema.status(201)),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('cancel', '/members/invitations/:id', {
    params: { id: InvitationId },
    success: Schema.Struct({ canceled: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('resend', '/members/invitations/:id/resend', {
    params: { id: InvitationId },
    success: InviteSent,
    error: API_ERRORS,
  }),
) {}
