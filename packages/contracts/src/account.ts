import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

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
 * What a server's API key may reach (ADR 0081): each scope opens its area's annotated owner endpoints. `inspect` reads
 * how the key's own chats ran, content-free (ADR 0084).
 */
export const KeyScope = Schema.Literals(['topics', 'conversations', 'personas', 'inspect'])
export type KeyScope = typeof KeyScope.Type

/**
 * What opens an owner endpoint to a caller other than the owner's session (ADRs 0086, 0098): a server's API key holds
 * some of the key scopes; an OAuth client holds what its consent maps to, and only it can hold `transcripts` (the
 * conversations in full), `agent` (asking the agent in main), `setup` (what setups are chosen from, and the Sources)
 * and `routines` (reading and drafting routines; confirming one stays the web's).
 */
export const CallerScope = Schema.Literals([...KeyScope.literals, 'transcripts', 'agent', 'setup', 'routines'])
export type CallerScope = typeof CallerScope.Type

/** An MCP connection a key's setups may name: the key's server ceiling. */
export const KeyServer = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/**
 * An MCP server origin the owner lets a key's threads connect to (ADR 0091), with exactly the tools they may call
 * there. `origin` is an https origin, normalized by `keyOriginsOf`; `tools` are explicit names, never `all`.
 */
export const KeyOrigin = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(200)),
  tools: Schema.Array(NonEmptyString(128)),
})
export type KeyOrigin = typeof KeyOrigin.Type

/** The most origins one key may hold, and the most tools one origin may name. */
const MAX_ORIGINS = 8
const MAX_TOOLS = 50

/** A host no key's thread may reach: an IP literal, a single label, or a name kept for local and private networks. */
const privateHost = (host: string): boolean =>
  !host.includes('.') ||
  /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) ||
  host.startsWith('[') ||
  ['.localhost', '.local', '.internal', '.home.arpa', '.lan'].some((suffix) => `.${host}`.endsWith(suffix))

/** `text`'s https origin (scheme, host and port), or none when it is anything more or less than one. */
const originOf = (text: string): string | undefined => {
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  const bare =
    url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  return url.protocol === 'https:' && bare && !privateHost(url.hostname) ? url.origin : undefined
}

/**
 * A key's origins as stored (ADR 0091): each origin normalized, at most 8 and none twice (`key_origin` otherwise), and
 * each with 1 to 50 tools, none of them `all` (`key_origin_tools` otherwise).
 */
export const keyOriginsOf = (
  origins: readonly KeyOrigin[],
): { readonly origins: readonly KeyOrigin[] } | { readonly problem: 'key_origin' | 'key_origin_tools' } => {
  const normalized = origins.map((each) => ({ origin: originOf(each.origin), tools: [...new Set(each.tools)] }))
  const valid = normalized.flatMap((each) => (each.origin === undefined ? [] : [{ ...each, origin: each.origin }]))
  if (origins.length > MAX_ORIGINS || valid.length < origins.length) return { problem: 'key_origin' }
  if (new Set(valid.map((each) => each.origin)).size < valid.length) return { problem: 'key_origin' }
  if (valid.some(({ tools }) => tools.length === 0 || tools.length > MAX_TOOLS || tools.includes('all')))
    return { problem: 'key_origin_tools' }
  return { origins: valid }
}

/** The origin a thread's server `url` is on, as `keyOriginsOf` stores origins; none for one no key may name. */
export const serverOriginOf = (url: string): string | undefined => {
  if (!URL.canParse(url)) return undefined
  const { protocol, hostname, origin } = new URL(url)
  return protocol === 'https:' && !privateHost(hostname) ? origin : undefined
}

/**
 * `POST /api/keys`: a key for a server the owner runs, its scopes, the servers its setups may use, the MCP origins its
 * threads may connect to (ADR 0091) and its lifetime.
 */
export const CreateApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w .:-]{1,64}$/u)),
  scopes: Schema.Array(KeyScope).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  servers: Schema.Array(KeyServer).check(Schema.isMaxLength(32)),
  origins: Schema.optional(Schema.Array(KeyOrigin)),
  expiresInDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
})
export type CreateApiKey = typeof CreateApiKey.Type

/**
 * `PATCH /api/keys/:keyId`: the key's scopes (ADR 0084) or its MCP origins (ADR 0091) from now on, whichever it names,
 * and at least one. It stays the same key, so what it made stays within its reach; its secret, servers and expiry do
 * not change.
 */
export const UpdateApiKey = Schema.Struct({
  scopes: Schema.optional(CreateApiKey.fields.scopes),
  origins: Schema.optional(Schema.Array(KeyOrigin)),
}).check(Schema.makeFilter((change) => change.scopes !== undefined || change.origins !== undefined))
export type UpdateApiKey = typeof UpdateApiKey.Type

/** A key as the owner sees it: its first characters, never its secret. */
export const ApiKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.optional(Schema.String),
  scopes: Schema.Array(KeyScope),
  servers: Schema.Array(KeyServer),
  origins: Schema.Array(KeyOrigin),
  createdAt: Schema.String,
  expiresAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
})
export type ApiKeyView = typeof ApiKeyView.Type

/** A new key and its secret, which is shown this once. */
export const CreatedApiKey = Schema.Struct({ key: ApiKeyView, secret: Schema.String })
export type CreatedApiKey = typeof CreatedApiKey.Type

/**
 * A member's role in a workspace (ADR 0089): an owner may delete it, an owner or admin manages it, a member works in
 * it.
 */
export const WorkspaceRole = Schema.Literals(['owner', 'admin', 'member'])
export type WorkspaceRole = typeof WorkspaceRole.Type

/** A workspace's ID, which also names its agent. */
export const WorkspaceId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))
export type WorkspaceId = typeof WorkspaceId.Type

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

/**
 * The workspaces an MCP client's consent reaches (ADR 0097): `all` of the person's, ones they join later included, or
 * those listed, while they are still a member of each. A reach of none reaches nothing until it is changed.
 */
export const ClientReach = Schema.Struct({
  all: Schema.Boolean,
  workspaces: Schema.Array(WorkspaceId).check(Schema.isMaxLength(200)),
})
export type ClientReach = typeof ClientReach.Type

/** A workspace a client reaches, as its person's list shows it. */
export const ReachedWorkspace = Schema.Struct({ id: WorkspaceId, slug: Schema.String, name: Schema.String })
export type ReachedWorkspace = typeof ReachedWorkspace.Type

/**
 * An MCP client a person authorized to use goblin's /mcp server (ADRs 0024, 0097): what it registered as, when they
 * consented, the `goblin:*` scopes their consent grants and the workspaces it reaches now.
 */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String),
  reach: Schema.Struct({ all: Schema.Boolean, workspaces: Schema.Array(ReachedWorkspace) }),
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
