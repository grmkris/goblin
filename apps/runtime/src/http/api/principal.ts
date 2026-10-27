import { Extra, GrantOrigin, Level, WorkspaceId, WorkspaceRole } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** The header the Worker forwards a credential in. */
export const CALLER_HEADER = 'x-goblin-caller'

const Coverage = Schema.Literals(['all', 'list'])

/**
 * A credential as the Worker forwards it (ADRs 0114, 0125): an OAuth client acting for a person, or an installed app
 * (ADR 0118, whose `id` is its client and whose grant is its installation's), its name, its grant's id, level and
 * extras, when it ends (epoch milliseconds, `null` until revoked), and in the workspace the request reaches whether its
 * Topics, Personas and connections are all or a list, with the reach's generation, so the agent knows when to read the
 * lists again (`Grants.sync`). The lists themselves never travel in the header; the MCP origins its threads may bring
 * do (ADR 0091). It holds what its grant holds, never renews resident authority and is counted per minute. Only the
 * Worker sets it: the edge for a token on `/w/<slug>/api` (ADR 0116), `/mcp` for one there.
 */
export const Credential = Schema.Struct({
  kind: Schema.Literals(['client', 'app']),
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
  origins: Schema.Array(GrantOrigin),
})
export type Credential = typeof Credential.Type

const ForwardedCredential = Schema.fromJsonString(Credential)

/**
 * The person a request acts for in its workspace (ADR 0089): their user ID and role. The edge forwards it for a
 * member's session, and the edge (ADR 0116) and `/mcp` for the person an OAuth client acts for.
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

/** The header value that forwards `credential`: ASCII whatever a client registered as its name. */
export const credentialHeader = (credential: Credential): string => asciiJson(credential)

/** A person's name as a member's messages carry it: theirs, or their address's local part. */
export const memberName = (person: { readonly name: string; readonly email: string }): string =>
  (person.name.trim() === '' ? (person.email.split('@')[0] ?? '') : person.name.trim()).slice(0, 80)

/**
 * Who a forwarded request comes from, as its headers say (ADRs 0089, 0114): a member (a session), a credential (an
 * installed app), or a credential and the member it acts for (an OAuth client). `undefined` for a request that says
 * neither, or whose header does not decode: it is refused, never taken for the owner.
 */
export const forwardedPrincipal = (
  request: Request,
): { readonly credential?: Credential; readonly member?: Member } | undefined => {
  const credentialValue = request.headers.get(CALLER_HEADER)
  const memberValue = request.headers.get(MEMBER_HEADER)
  const credential =
    credentialValue === null
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedCredential)(credentialValue))
  const member =
    memberValue === null ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedMember)(memberValue))
  if ((credentialValue !== null && credential === undefined) || (memberValue !== null && member === undefined))
    return undefined
  if (credential === undefined && member === undefined) return undefined
  return { ...(credential === undefined ? {} : { credential }), ...(member === undefined ? {} : { member }) }
}

/** One name for a credential, for its per-minute count (ADR 0085): its grant's. */
export const credentialId = (credential: Credential): string => `grant:${credential.grantId}`

/**
 * The OAuth token a request carries (ADRs 0116, 0118): its `Authorization` bearer, a client's or an installed app's.
 * Whether it is one is the token check's to say (`inbound/client-access.ts`).
 */
export const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length)
  return token === '' ? undefined : token
}
