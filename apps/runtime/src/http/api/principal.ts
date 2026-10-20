import { KeyScope, KeyServer } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { KEY_PREFIX } from '../../auth/resources.ts'

/**
 * A server's API key as the agent sees it (ADR 0081): which key, its scopes and its server ceiling. The edge verifies
 * the key and forwards this; the agent never sees the secret, and a request cannot supply it (the edge rebuilds the
 * headers it forwards, and only it, or `/mcp` for the same key, sets this one).
 */
export interface KeyGrant {
  readonly keyId: string
  readonly scopes: readonly KeyScope[]
  readonly servers: readonly string[]
}

/** The header the edge forwards a key's grant in. */
export const KEY_HEADER = 'x-goblin-key'

const ForwardedKey = Schema.fromJsonString(
  Schema.Struct({
    keyId: Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u)),
    scopes: Schema.Array(KeyScope),
    servers: Schema.Array(KeyServer),
  }),
)

/** The header value that forwards `key`. */
export const keyHeader = (key: KeyGrant): string =>
  JSON.stringify({ keyId: key.keyId, scopes: key.scopes, servers: key.servers })

/** The grant a forwarded request carries, when a key sent it; none for the owner's session. */
export const forwardedKey = (request: Request): KeyGrant | undefined => {
  const value = request.headers.get(KEY_HEADER)
  return value === null ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ForwardedKey)(value))
}

/** The key a request carries, when its `Authorization` header is a `gbk_` bearer: never an inbound OAuth token. */
export const bearerKey = (request: Request): string | undefined => {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith(`Bearer ${KEY_PREFIX}`)) return undefined
  const key = header.slice('Bearer '.length)
  return /^gbk_[A-Za-z0-9]{32,128}$/u.test(key) ? key : undefined
}
