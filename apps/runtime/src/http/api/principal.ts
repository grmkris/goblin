import { CallerScope, KeyScope, KeyServer } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { KEY_PREFIX } from '../../auth/resources.ts'

/**
 * A server's API key as the agent sees it (ADR 0081): which key, its scopes and its server ceiling. The edge verifies
 * the key and forwards it as the request's caller; the agent never sees the secret.
 */
export interface KeyGrant {
  readonly keyId: string
  readonly scopes: readonly KeyScope[]
  readonly servers: readonly string[]
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
      scopes: Schema.Array(KeyScope),
      servers: Schema.Array(KeyServer),
    }),
    Schema.Struct({
      kind: Schema.Literal('client'),
      clientId: Schema.String.check(Schema.isPattern(/^[\w.:-]{1,200}$/u)),
      name: Schema.String.check(Schema.isMaxLength(200)),
      scopes: Schema.Array(CallerScope),
    }),
  ]),
)

/** The header value that forwards `caller`. */
export const callerHeader = (caller: Caller): string => JSON.stringify(caller)

/** The caller a forwarded request carries; none for the owner's session. */
export const forwardedCaller = (request: Request): Caller | undefined => {
  const value = request.headers.get(CALLER_HEADER)
  return value === null ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedCaller)(value))
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
