import { Predicate } from 'effect'
import { APIError } from 'better-auth/api'

/**
 * What the MCP authorization spec (2026-07-28, Basic › Authorization) asks of goblin's authorization server that Better
 * Auth's options cannot express (ADR 0122), applied in its before hook to the bodies and queries it hands us, and to the
 * token request and discovery documents in `handleAuth`:
 *
 * - a redirect URI is `localhost` or https: a private-use scheme (`cursor://…`) is refused at registration and at
 *   authorization, so a Client ID Metadata Document that lists one gets no further than a dynamic registration would;
 * - a public client's registration narrows its grant types to the two it may hold, as RFC 7591 §3.2.1 allows, instead of
 *   refusing it for declaring more (VS Code declares `device_code`, Claude `jwt-bearer`);
 * - every authorization asks for `offline_access`, so an MCP client gets a refresh token without asking for the scope;
 *   whether one is issued stays the client's registered grant types (`refresh_token`), which Better Auth checks;
 * - DPoP is not implemented, so nothing offers it: no advertised algorithms, no proof read at the token endpoint, no
 *   key thumbprint bound through the authorization request, no registration asking for bound tokens. Tokens are plain
 *   bearer, audience-bound (RFC 8707); a token carrying a confirmation is refused (`principal.ts`).
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The grants a dynamically registered client may hold; `client_credentials` is goblin's own apps' (ADR 0118). */
const PUBLIC_GRANTS: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token'])
const REFRESH_SCOPE = 'offline_access'
const DISCOVERY_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'] as const

/** `localhost` (http on the loopback names and literals) or https (security considerations §"Redirect URI validation"). */
export const isAllowedRedirectUri = (uri: unknown): boolean => {
  if (!Predicate.isString(uri)) return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    // expected: a redirect URI that does not parse is refused.
    return false
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
}

const field = (object: object, name: string): unknown =>
  Predicate.hasProperty(object, name) ? object[name] : undefined
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value)

/** `/oauth2/register`: every redirect allowed, grant types narrowed, no DPoP binding; the body is changed in place. */
export const guardRegistration = (body: unknown): void => {
  if (!Predicate.isObject(body)) return
  const uris = field(body, 'redirect_uris')
  const refused = isList(uris) ? uris.find((uri) => !isAllowedRedirectUri(uri)) : undefined
  if (refused !== undefined)
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_redirect_uri',
      error_description: `redirect URIs must be localhost or https: ${JSON.stringify(refused)}`,
    })
  const grants = field(body, 'grant_types')
  if (isList(grants))
    Object.assign(body, {
      grant_types: grants.filter((grant) => Predicate.isString(grant) && PUBLIC_GRANTS.has(grant)),
    })
  if ('dpop_bound_access_tokens' in body) delete body.dpop_bound_access_tokens
}

/** `/oauth2/authorize`: the redirect allowed, `offline_access` asked, no DPoP thumbprint; the query is changed in place. */
export const guardAuthorization = (query: unknown): void => {
  if (!Predicate.isObject(query)) return
  const redirect = field(query, 'redirect_uri')
  if (redirect !== undefined && !isAllowedRedirectUri(redirect))
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_request',
      error_description: 'redirect_uri must be localhost or https',
    })
  const scope = field(query, 'scope')
  if (Predicate.isString(scope) && !scope.split(' ').includes(REFRESH_SCOPE))
    Object.assign(query, { scope: scope === '' ? REFRESH_SCOPE : `${scope} ${REFRESH_SCOPE}` })
  if ('dpop_jkt' in query) delete query.dpop_jkt
}

/** The token request without its DPoP proof: an authorization server without DPoP ignores it (RFC 9449 §5) and issues a bearer token. */
export const withoutDpopProof = (request: Request): Request => {
  if (!request.headers.has('dpop')) return request
  const headers = new Headers(request.headers)
  headers.delete('dpop')
  return new Request(request, { headers })
}

/** Whether `path` serves one of the two authorization server documents, at any of the spec's discovery locations. */
export const isDiscoveryPath = (path: string): boolean => DISCOVERY_PATHS.some((known) => path.includes(known))

/** A discovery document that offers no DPoP; any other answer is returned as it came. */
export const withoutDpopMetadata = async (response: Response): Promise<Response> => {
  if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('application/json'))
    return response
  const document: unknown = await response.json()
  const offered =
    Predicate.isObject(document) && 'dpop_signing_alg_values_supported' in document
      ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'dpop_signing_alg_values_supported'))
      : document
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(offered), { status: response.status, headers })
}
