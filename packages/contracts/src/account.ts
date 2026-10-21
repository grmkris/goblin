import * as Schema from 'effect/Schema'

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

/** An MCP client the owner has authorized to use goblin's /mcp server. */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
})
export type InboundClient = typeof InboundClient.Type

/**
 * What a server's API key may reach (ADR 0081): each scope opens its area's annotated owner endpoints. `inspect` reads
 * how the key's own chats ran, content-free (ADR 0084).
 */
export const KeyScope = Schema.Literals(['topics', 'conversations', 'personas', 'inspect'])
export type KeyScope = typeof KeyScope.Type

/**
 * What opens an owner endpoint to a caller other than the owner's session (ADR 0086): a server's API key holds some of
 * the key scopes; an OAuth client of the owner holds what its consent maps to, and only it can hold `transcripts` (the
 * conversations in full) and `agent` (asking the agent in main).
 */
export const CallerScope = Schema.Literals([...KeyScope.literals, 'transcripts', 'agent'])
export type CallerScope = typeof CallerScope.Type

/** An MCP connection a key's setups may name: the key's server ceiling. */
export const KeyServer = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/** `POST /api/keys`: a key for a server the owner runs, its scopes, the servers its setups may use and its lifetime. */
export const CreateApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w .:-]{1,64}$/u)),
  scopes: Schema.Array(KeyScope).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  servers: Schema.Array(KeyServer).check(Schema.isMaxLength(32)),
  expiresInDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
})
export type CreateApiKey = typeof CreateApiKey.Type

/**
 * `PATCH /api/keys/:keyId`: the key's scopes from now on (ADR 0084). It stays the same key, so what it made stays within
 * its reach; its secret, servers and expiry do not change.
 */
export const UpdateApiKey = Schema.Struct({ scopes: CreateApiKey.fields.scopes })
export type UpdateApiKey = typeof UpdateApiKey.Type

/** A key as the owner sees it: its first characters, never its secret. */
export const ApiKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.optional(Schema.String),
  scopes: Schema.Array(KeyScope),
  servers: Schema.Array(KeyServer),
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

/** A workspace as one of its members sees it: what it is called, its address and their role in it. */
export const WorkspaceView = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  slug: Schema.String,
  role: WorkspaceRole,
})
export type WorkspaceView = typeof WorkspaceView.Type

/** `POST /api/workspaces`: a new workspace with its own agent, its maker its owner. A taken slug is a conflict. */
export const CreateWorkspace = Schema.Struct({ name: WorkspaceName, slug: WorkspaceSlug })
export type CreateWorkspace = typeof CreateWorkspace.Type

/** `PATCH /api/workspaces/:workspaceId`: a new name, a new slug, or both. A taken slug is a conflict. */
export const UpdateWorkspace = Schema.Struct({
  name: Schema.optional(WorkspaceName),
  slug: Schema.optional(WorkspaceSlug),
})
export type UpdateWorkspace = typeof UpdateWorkspace.Type
