// Adapted from OIDC UI's public verify registry. Goblin bounds the cache and network, refuses stale discovery,
// requires short token lifetimes, and returns fixed errors without issuer or claim content (ADR 0024).
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'
import { type OidcPolicy, matchesOidcPolicy, validateOidcPolicy } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { readBytes } from '../http/body.ts'
import { Unauthenticated } from '../http/errors.ts'
import { isPublicHttps } from '../mcp/servers/endpoint.ts'

const Discovery = Schema.Struct({ issuer: Schema.String, jwks_uri: Schema.String })
const decodeDiscovery = Schema.decodeUnknownSync(Discovery)
const MAX_ISSUERS = 64
const TTL = 300_000
const MAX_TOKEN_BYTES = 16_384

export type OidcCode =
  | 'missing-token'
  | 'malformed-token'
  | 'unknown-issuer'
  | 'invalid-policy'
  | 'discovery-failed'
  | 'invalid-token'
  | 'claims-mismatch'
  | 'ambiguous-policy'

export type OidcResult =
  | { readonly ok: true; readonly policy: OidcPolicy; readonly claims: JWTPayload }
  | { readonly ok: false; readonly code: OidcCode }

export type OidcFetch = (url: string, init: RequestInit) => Promise<Response>

/** Read only the issuer as a lookup hint. This grants nothing and never starts discovery. */
export const workloadIssuer = (token: string): string | undefined => {
  if (token.length > MAX_TOKEN_BYTES) return undefined
  try {
    const claims = decodeJwt(token)
    return typeof claims.iss === 'string' && claims.iss.length <= 2048 ? claims.iss : undefined
  } catch {
    // expected: malformed JWTs have no lookup hint and are refused before any network call.
    return undefined
  }
}

const shortLived = (claims: JWTPayload): boolean => {
  const { iat, exp, sub } = claims
  const now = Date.now() / 1000
  return (
    typeof iat === 'number' &&
    Number.isSafeInteger(iat) &&
    iat <= now &&
    typeof exp === 'number' &&
    Number.isSafeInteger(exp) &&
    exp > iat &&
    exp - iat <= 600 &&
    typeof sub === 'string' &&
    sub.length > 0 &&
    sub.length <= 2048
  )
}

class IssuerKeys {
  readonly #cache = new Map<string, { readonly until: number; readonly keys?: ReturnType<typeof createRemoteJWKSet> }>()
  constructor(readonly fetcher: OidcFetch) {}

  put(issuer: string, value: { readonly until: number; readonly keys?: ReturnType<typeof createRemoteJWKSet> }) {
    if (!this.#cache.has(issuer) && this.#cache.size >= MAX_ISSUERS) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    this.#cache.set(issuer, value)
  }

  readonly boundedFetch: OidcFetch = async (url, init) => {
    if (!isPublicHttps(new URL(url))) throw new Unauthenticated({ reason: 'discovery-failed' })
    const timeout = AbortSignal.timeout(5000)
    const signal = init.signal === undefined || init.signal === null ? timeout : AbortSignal.any([timeout, init.signal])
    const response = await this.fetcher(url, { ...init, redirect: 'manual', signal })
    if (!response.ok) throw new Unauthenticated({ reason: 'discovery-failed' })
    const body = await readBytes(response, 65_536)
    return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } })
  }

  async discover(issuer: string) {
    const held = this.#cache.get(issuer)
    if (held !== undefined && held.until > Date.now()) {
      if (held.keys === undefined) throw new Unauthenticated({ reason: 'discovery-failed' })
      return held.keys
    }
    try {
      const document = await this.boundedFetch(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`, {})
      const discovery = decodeDiscovery(await document.json())
      const jwks = new URL(discovery.jwks_uri)
      if (discovery.issuer !== issuer || jwks.origin !== new URL(issuer).origin)
        throw new Unauthenticated({ reason: 'discovery-failed' })
      const keys = createRemoteJWKSet(jwks, {
        [customFetch]: this.boundedFetch,
        cacheMaxAge: TTL,
        cooldownDuration: 30_000,
        timeoutDuration: 5000,
      })
      this.put(issuer, { until: Date.now() + TTL, keys })
      return keys
    } catch {
      // expected: discovery errors fail closed and back off briefly; no stale resolver is reused.
      this.put(issuer, { until: Date.now() + 10_000 })
      throw new Unauthenticated({ reason: 'discovery-failed' })
    }
  }
}

const verifiedClaims = async (token: string, issuer: string, keys: IssuerKeys): Promise<JWTPayload> => {
  const resolver = await keys.discover(issuer)
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer,
      algorithms: ['ES256', 'RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    })
    if (!shortLived(payload)) throw new Unauthenticated({ reason: 'invalid-token' })
    return payload
  } catch {
    // expected: signature, time and key retrieval failures expose no provider details.
    throw new Unauthenticated({ reason: 'invalid-token' })
  }
}

const verifyWith = async (
  keys: IssuerKeys,
  token: string | null | undefined,
  policies: readonly OidcPolicy[],
): Promise<OidcResult> => {
  if (token === null || token === undefined || token === '') return { ok: false, code: 'missing-token' }
  const issuer = workloadIssuer(token)
  if (issuer === undefined) return { ok: false, code: 'malformed-token' }
  const candidates = policies.filter((policy) => policy.issuer === issuer)
  if (candidates.length === 0) return { ok: false, code: 'unknown-issuer' }
  const valid = candidates.filter((policy) => validateOidcPolicy(policy).length === 0)
  if (valid.length === 0 || !isPublicHttps(new URL(issuer))) return { ok: false, code: 'invalid-policy' }
  let claims: JWTPayload
  try {
    claims = await verifiedClaims(token, issuer, keys)
  } catch (cause) {
    // expected: the two fixed verification errors carry no issuer or claim content.
    return {
      ok: false,
      code:
        cause instanceof Unauthenticated && cause.reason === 'discovery-failed' ? 'discovery-failed' : 'invalid-token',
    }
  }
  const matched = valid.filter((policy) => matchesOidcPolicy(policy, claims))
  const [policy] = matched
  if (policy === undefined) return { ok: false, code: 'claims-mismatch' }
  if (matched.length !== 1) return { ok: false, code: 'ambiguous-policy' }
  return { ok: true, policy, claims }
}

/** An isolate-local verifier; tests inject a keyless issuer's fetch. Policies and grants are never cached. */
export const makeOidcVerifier = (fetcher: OidcFetch = fetch) => {
  const keys = new IssuerKeys(fetcher)
  return (token: string | null | undefined, policies: readonly OidcPolicy[]) => verifyWith(keys, token, policies)
}

/** Production verifier, shared for the isolate's lifetime, with bounded public discovery only. */
export const verifyOidcToken = makeOidcVerifier()
