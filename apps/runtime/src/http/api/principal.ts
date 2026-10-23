import {
  CallerScope,
  Extra,
  KeyOrigin,
  KeyScope,
  KeyServer,
  Level,
  WorkspaceId,
  WorkspaceRole,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { KEY_PREFIX } from '../../auth/resources.ts'

/**
 * A server's API key as the agent sees it (ADR 0081): which key and its name, its scopes and its ceiling, the
 * connections its setups may name and the MCP origins (with their tools) its threads may connect to (ADR 0091). The edge
 * verifies the key and forwards it as the request's caller; the agent never sees the secret.
 */
export interface KeyGrant {
  readonly keyId: string
  /** The name the owner gave it, which its messages and what it made carry (ADR 0108). */
  readonly name: string
  readonly scopes: readonly KeyScope[]
  readonly servers: readonly string[]
  readonly origins: readonly KeyOrigin[]
}

/** An OAuth client of the owner on /mcp (ADR 0086): which client, the name it registered and what its consent grants. */
export interface ClientGrant {
  readonly clientId: string
  readonly name: string
  readonly scopes: readonly CallerScope[]
}

/**
 * Who an owner request comes from when it is not the owner's session (ADR 0086): a server's key, which reaches only what
 * it made, or an OAuth client, which reaches what the owner does. Either holds scopes, never renews resident authority
 * and is counted per minute. Only the Worker sets it: the edge for a key on `/api`, `/mcp` for either.
 */
export type Caller = ({ readonly kind: 'key' } & KeyGrant) | ({ readonly kind: 'client' } & ClientGrant)

/** The header the Worker forwards a caller in. */
export const CALLER_HEADER = 'x-goblin-caller'

const ForwardedCaller = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('key'),
      keyId: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
      name: Schema.String.check(Schema.isMaxLength(200)),
      scopes: Schema.Array(KeyScope),
      servers: Schema.Array(KeyServer),
      origins: Schema.Array(KeyOrigin),
    }),
    Schema.Struct({
      kind: Schema.Literal('client'),
      clientId: Schema.String.check(Schema.isPattern(/^[\w.:-]{1,200}$/u)),
      name: Schema.String.check(Schema.isMaxLength(200)),
      scopes: Schema.Array(CallerScope),
    }),
  ]),
)

const Coverage = Schema.Literals(['all', 'list'])

/**
 * A credential as the Worker forwards it once grants are kept: a server's key or an OAuth client acting for a person,
 * its name, its grant's id, level and extras, when it ends (epoch milliseconds, `null` until revoked), and in the
 * workspace the request reaches whether its Topics, Personas and connections are all or a list, with the reach's
 * generation, so the agent knows when to read the lists again. The lists themselves never travel in the header; the
 * MCP origins its threads may bring do (ADR 0091).
 *
 * @internal The forwarded caller is still `ForwardedCaller`; a test holds this shape until the edge forwards it.
 */
export const Credential = Schema.Struct({
  kind: Schema.Literals(['key', 'client']),
  id: Schema.String.check(Schema.isPattern(/^[\w.:-]{1,200}$/u)),
  name: Schema.String.check(Schema.isMaxLength(200)),
  grantId: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
  level: Level,
  extras: Schema.Array(Extra),
  expiresAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ws: Schema.Struct({
    workspace: WorkspaceId,
    topics: Coverage,
    personas: Coverage,
    connections: Coverage,
    generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  origins: Schema.Array(KeyOrigin),
})
export type Credential = typeof Credential.Type

/** The header value that forwards `caller`. */
export const callerHeader = (caller: Caller): string => JSON.stringify(caller)

/**
 * The person a request acts for in its workspace (ADR 0089): their user ID and role. The edge forwards it for a
 * member's session, and `/mcp` for the person an OAuth client acts for.
 */
export interface Member {
  readonly user: string
  readonly role: WorkspaceRole
  /** Their name as the workspace's people see it (ADR 0094). */
  readonly name: string
  /** Whether the workspace has other people too: then each of the member's messages carries who wrote it. */
  readonly shared: boolean
}

/** The header the Worker forwards a member in. */
export const MEMBER_HEADER = 'x-goblin-member'

const ForwardedMember = Schema.fromJsonString(
  Schema.Struct({
    user: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
    role: WorkspaceRole,
    name: Schema.String.check(Schema.isMaxLength(80)),
    shared: Schema.Boolean,
  }),
)

/** `\u` escapes for every code unit outside ASCII, so a header carries any name as it is (JSON reads them back). */
const asciiJson = (value: unknown): string => {
  const json = JSON.stringify(value)
  return Array.from({ length: json.length }, (_, index) => {
    const code = json.charCodeAt(index)
    return code < 0x7f ? json.charAt(index) : `\\u${code.toString(16).padStart(4, '0')}`
  }).join('')
}

/** The header value that forwards `member`: ASCII whatever their name. */
export const memberHeader = (member: Member): string =>
  asciiJson({ user: member.user, role: member.role, name: member.name, shared: member.shared })

/** A person's name as a member's messages carry it: theirs, or their address's local part. */
export const memberName = (person: { readonly name: string; readonly email: string }): string =>
  (person.name.trim() === '' ? (person.email.split('@')[0] ?? '') : person.name.trim()).slice(0, 80)

/**
 * Who a forwarded request comes from, as its headers say (ADR 0089): a member (a session), a caller (a key), or a
 * caller and the member it acts for (an OAuth client). `undefined` for a request that says neither, or whose header
 * does not decode: it is refused, never taken for the owner.
 */
export const forwardedPrincipal = (
  request: Request,
): { readonly caller?: Caller; readonly member?: Member } | undefined => {
  const callerValue = request.headers.get(CALLER_HEADER)
  const memberValue = request.headers.get(MEMBER_HEADER)
  const caller =
    callerValue === null ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedCaller)(callerValue))
  const member =
    memberValue === null ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedMember)(memberValue))
  if ((callerValue !== null && caller === undefined) || (memberValue !== null && member === undefined)) return undefined
  if (caller === undefined && member === undefined) return undefined
  return { ...(caller === undefined ? {} : { caller }), ...(member === undefined ? {} : { member }) }
}

/** One name for a caller across both kinds, for its per-minute count. */
export const callerId = (caller: Caller): string =>
  caller.kind === 'key' ? `key:${caller.keyId}` : `client:${caller.clientId}`

/** The key a request carries, when its `Authorization` header is a `gbk_` bearer: never an inbound OAuth token. */
export const bearerKey = (request: Request): string | undefined => {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith(`Bearer ${KEY_PREFIX}`)) return undefined
  const key = header.slice('Bearer '.length)
  return /^gbk_[A-Za-z0-9]{32,128}$/u.test(key) ? key : undefined
}
