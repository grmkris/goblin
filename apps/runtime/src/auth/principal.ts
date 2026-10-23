import { Predicate } from 'effect'
import { Unauthenticated } from '../http/errors.ts'

/**
 * An inbound MCP client acting for a person with a Better Auth access token. Never a session. What it may do and which
 * workspaces it reaches are its grant's (ADR 0114), read on every call, never a claim: the token's `scope` counts for
 * nothing.
 */
export type ClientPrincipal = {
  readonly clientId: string
  readonly subject: string
  readonly expiresAt: number
}
export interface TokenClaims {
  readonly iss?: unknown
  readonly sub?: unknown
  readonly aud?: unknown
  readonly azp?: unknown
  readonly client_id?: unknown
  readonly exp?: unknown
  readonly cnf?: unknown
}
const text = (value: unknown): value is string => Predicate.isString(value) && value.length > 0
const audiences = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(text) : text(value) ? [value] : []

/** Check the claims the signature does not: issuer, audience (our /mcp resource), expiry, subject and client. */
export const clientFromClaims = (
  claims: TokenClaims,
  expected: { readonly issuer: string; readonly resource: string; readonly now: number },
): ClientPrincipal => {
  const clientId = text(claims.azp) ? claims.azp : claims.client_id
  if (!text(claims.iss) || claims.iss !== expected.issuer) throw new Unauthenticated({ reason: 'issuer' })
  if (!audiences(claims.aud).includes(expected.resource)) throw new Unauthenticated({ reason: 'audience' })
  if (!Predicate.isNumber(claims.exp) || !Number.isSafeInteger(claims.exp) || claims.exp <= expected.now)
    throw new Unauthenticated({ reason: 'expired' })
  if (!text(claims.sub)) throw new Unauthenticated({ reason: 'subject' })
  if (!text(clientId)) throw new Unauthenticated({ reason: 'client' })
  if (claims.cnf !== undefined) throw new Unauthenticated({ reason: 'sender-constrained tokens are not supported' })
  return { clientId, subject: claims.sub, expiresAt: claims.exp }
}
