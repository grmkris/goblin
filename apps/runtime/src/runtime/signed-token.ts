// A token that carries its own claims (ADR 0070): base64url JSON and its HMAC, under a key derived from `CREDENTIAL_KEY`
// for one purpose only, so a token made for one purpose never verifies for another. The Worker checks one before any
// agent wakes; plain WebCrypto, so it needs none of the agent's runtime.
import type { JsonObject } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { base64url, bytesOfBase64url, purposeMac, purposeMacMatches } from './purpose-key.ts'

/** A token's two parts: its claims as base64url JSON, and their HMAC. */
const TOKEN = /^([\w-]{1,4096})\.([\w-]{43})$/u

/** The token of `claims` for `purpose`. */
export async function signedToken(credentialKey: string, purpose: string, claims: JsonObject): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  return `${body}.${await purposeMac(credentialKey, purpose, body)}`
}

/**
 * What `token` says, as `claims` reads it, when goblin made it for `purpose` (its HMAC compared in constant time):
 * none for anything else.
 */
export async function signedClaims<A>(
  credentialKey: string,
  purpose: string,
  token: string,
  claims: Schema.Decoder<A>,
): Promise<A | undefined> {
  const [, body = '', mac = ''] = TOKEN.exec(token) ?? []
  if (body === '' || !(await purposeMacMatches(credentialKey, purpose, body, mac))) return undefined
  // Only a body goblin signed is read, so it is base64url JSON.
  const json = new TextDecoder().decode(bytesOfBase64url(body))
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(claims))(json))
}
