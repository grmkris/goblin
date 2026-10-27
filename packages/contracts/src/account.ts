import * as Schema from 'effect/Schema'
import { GrantTerms } from './grants.ts'
import { WorkspaceId } from './ids.ts'

/** A `path:line:col` stack location, never a message. */
const StackFrame = Schema.String.check(Schema.isMaxLength(300), Schema.isPattern(/^\S+:\d{1,7}:\d{1,7}$/u))
const Token = (max: number) => Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(/^[\w.:-]*$/u))
const MAX_CLIENT_ERROR_BYTES = 2048

/**
 * `POST /api/client-errors`: a browser crash, content-free (ADR 0024). The route id (a template such as `/c/$chatId`,
 * never a URL), the error's class name and at most 12 stack locations, the build, and the ref of the response that
 * failed when there was one. Never the message.
 */
export const ClientErrorReport = Schema.Struct({
  route: Schema.String.check(Schema.isMaxLength(120), Schema.isPattern(/^[\w$./{}()-]*$/u)),
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u)),
  frames: Schema.Array(StackFrame).check(Schema.isMaxLength(12)),
  build: Token(40),
  ref: Schema.optional(Token(64)),
}).check(
  Schema.makeFilter((report) => new TextEncoder().encode(JSON.stringify(report)).length <= MAX_CLIENT_ERROR_BYTES),
)
export type ClientErrorReport = typeof ClientErrorReport.Type

/**
 * A member's role in a workspace (ADR 0089): an owner may delete it, an owner or admin manages it, a member works in
 * it.
 */
export const WorkspaceRole = Schema.Literals(['owner', 'admin', 'member'])
export type WorkspaceRole = typeof WorkspaceRole.Type

/** A workspace's address in the app's pages (`/w/<slug>/…`): 3 to 40 lowercase letters, digits and inner hyphens. */
export const WorkspaceSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/u))
export type WorkspaceSlug = typeof WorkspaceSlug.Type

/** A workspace's name, as its members see it. */
export const WorkspaceName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^\S(?:.*\S)?$/u),
)

/**
 * A workspace as one of its members sees it: what it is called, its address, their role in it and how many people it
 * has (ADR 0094: its members' messages then name who wrote them).
 */
export const WorkspaceView = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  slug: Schema.String,
  role: WorkspaceRole,
  members: Schema.Int,
})
export type WorkspaceView = typeof WorkspaceView.Type

/** A workspace a client reaches, as its person's list shows it. */
export const ReachedWorkspace = Schema.Struct({ id: WorkspaceId, slug: Schema.String, name: Schema.String })
export type ReachedWorkspace = typeof ReachedWorkspace.Type

/**
 * An MCP client a person authorized to use goblin's /mcp server (ADRs 0024, 0097, 0114): what it registered as, when
 * they consented, the workspaces it reaches now, and the grant they gave it (`grantId`, `terms`; absent only for a
 * consent its grant was revoked under, which admits nothing).
 */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
  reach: Schema.Struct({ all: Schema.Boolean, workspaces: Schema.Array(ReachedWorkspace) }),
  grantId: Schema.optionalKey(Schema.String),
  terms: Schema.optionalKey(GrantTerms),
})
export type InboundClient = typeof InboundClient.Type

/** `POST /api/workspaces`: a new workspace with its own agent, its maker its owner. A taken slug is a conflict. */
export const CreateWorkspace = Schema.Struct({ name: WorkspaceName, slug: WorkspaceSlug })
export type CreateWorkspace = typeof CreateWorkspace.Type

/** `PATCH /api/workspaces/:workspaceId`: a new name, a new slug, or both. A taken slug is a conflict. */
export const UpdateWorkspace = Schema.Struct({
  name: Schema.optional(WorkspaceName),
  slug: Schema.optional(WorkspaceSlug),
})
export type UpdateWorkspace = typeof UpdateWorkspace.Type

/** A member as the workspace's members see them (ADR 0093): who they are, their role and since when. */
export const MemberView = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: WorkspaceRole,
  joinedAt: Schema.String,
})
export type MemberView = typeof MemberView.Type

/** An invitation's state: waiting for its person, taken, turned down, withdrawn, or past its seven days. */
export const InvitationState = Schema.Literals(['pending', 'accepted', 'declined', 'canceled', 'expired'])
export type InvitationState = typeof InvitationState.Type

/** An invitation as the workspace's owners and admins see it. */
export const InvitationView = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: WorkspaceRole,
  state: InvitationState,
  invitedBy: Schema.String,
  expiresAt: Schema.String,
})
export type InvitationView = typeof InvitationView.Type

/** An address an invitation goes to. */
const InviteEmail = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u))

/** `POST /w/<slug>/api/members/invitations`: invitations for these addresses, each with `role` (never `owner`). */
export const InviteMembers = Schema.Struct({
  emails: Schema.Array(InviteEmail).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  role: Schema.Literals(['admin', 'member']),
})
export type InviteMembers = typeof InviteMembers.Type

/** What inviting did for one address: its invitation, and whether its mail went out (else share its link). */
export const InviteSent = Schema.Struct({ invitation: InvitationView, mailed: Schema.Boolean })
export type InviteSent = typeof InviteSent.Type

/** `PATCH /w/<slug>/api/members/:userId`: a member's new role. */
export const UpdateMember = Schema.Struct({ role: WorkspaceRole })
export type UpdateMember = typeof UpdateMember.Type

/**
 * An invitation as its link shows it, signed in or not (ADR 0093): the workspace, who invited, the address it is for,
 * its role and state. The link's ID is the only proof; joining needs a session of that address.
 */
export const InvitationPreview = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  invitedBy: Schema.String,
  email: Schema.String,
  role: WorkspaceRole,
  state: InvitationState,
})
export type InvitationPreview = typeof InvitationPreview.Type
