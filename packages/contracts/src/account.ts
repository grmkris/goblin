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

/** What a server's API key may reach (ADR 0081): each scope opens its area's annotated owner endpoints. */
export const KeyScope = Schema.Literals(['topics', 'conversations', 'personas'])
export type KeyScope = typeof KeyScope.Type

/** An MCP connection a key's setups may name: the key's server ceiling. */
export const KeyServer = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/** `POST /api/keys`: a key for a server the owner runs, its scopes, the servers its setups may use and its lifetime. */
export const CreateApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w .:-]{1,64}$/u)),
  scopes: Schema.Array(KeyScope).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  servers: Schema.Array(KeyServer).check(Schema.isMaxLength(32)),
  expiresInDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
})
export type CreateApiKey = typeof CreateApiKey.Type

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
