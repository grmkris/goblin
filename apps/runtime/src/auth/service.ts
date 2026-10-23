import { verifyJwsAccessToken } from 'better-auth/oauth2'
import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'
import { Unauthenticated } from '../http/errors.ts'
import { isOidcPath } from './oidc.ts'
import { AUTH_BASE_PATH, authIssuer, createAuth } from './options.ts'
import { type GrantRecord, grantOfClient, isLive, revokeClientGrant } from './grants.ts'
import { clientFromClaims, type ClientPrincipal, type TokenClaims } from './principal.ts'
import { mcpResource, protectedResourceMetadata } from './resources.ts'
import type { Person } from './workspaces.ts'

type UserSession = {
  readonly userId: string
  readonly person: Person
  readonly expiresAt: number
}

/**
 * A signed-in person's browser session (cookie), which reaches the workspaces they belong to (ADR 0089). Bearer tokens
 * never count: a request that carries one is rejected here, so inbound MCP clients cannot reach owner routes or
 * outbound credentials.
 */
export const requireUserSession = async (request: Request, env: RuntimeEnv): Promise<UserSession> => {
  if (request.headers.has('authorization')) throw new Unauthenticated({ reason: 'session required' })
  const session = await createAuth(env, env.AUTH_DB).api.getSession({ headers: request.headers })
  if (session === null || session.session.expiresAt.getTime() <= Date.now())
    throw new Unauthenticated({ reason: 'session required' })
  return {
    userId: session.user.id,
    person: { id: session.user.id, name: session.user.name, email: session.user.email },
    expiresAt: Math.floor(session.session.expiresAt.getTime() / 1000),
  }
}

/**
 * An inbound MCP client's access token: a signature from our own JWKS (read locally, no self-fetch), our issuer and
 * /mcp audience, an enabled client, the person's standing consent to it (ADR 0097: a consent names no workspace) and
 * the live grant they gave it (ADR 0114). The token's scopes count for nothing: what it may do is that grant, read on
 * every call, so changing it in Settings applies to the live token at once and revoking the client ends it. A grant
 * past its end ends the consent and the client's refresh tokens with it (`grant_expired`), so the next sign-in asks
 * again, pre-filled with the same terms.
 */
export const verifyClientToken = async (
  token: string,
  env: RuntimeEnv,
): Promise<ClientPrincipal & { readonly grant: GrantRecord }> => {
  const auth = createAuth(env, env.AUTH_DB)
  const resource = mcpResource(env.APP_URL)
  let claims: TokenClaims
  try {
    claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer: authIssuer(env.APP_URL), audience: resource },
    })
  } catch {
    throw new Unauthenticated({ reason: 'token' })
  }
  const principal = clientFromClaims(claims, { issuer: authIssuer(env.APP_URL), resource, now: nowSeconds() })
  const client = await env.AUTH_DB.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?')
    .bind(principal.clientId)
    .first<{ disabled: number | null }>()
  if (client === null || client.disabled === 1) throw new Unauthenticated({ reason: 'client revoked' })
  const consent = await env.AUTH_DB.prepare(
    'SELECT 1 AS present FROM oauthConsent WHERE clientId = ? AND userId = ? AND referenceId IS NULL',
  )
    .bind(principal.clientId, principal.subject)
    .first<{ present: number }>()
  if (consent === null) throw new Unauthenticated({ reason: 'consent revoked' })
  const grant = await grantOfClient(env.AUTH_DB, principal.clientId, principal.subject)
  if (grant === undefined || grant.revokedAt !== null) throw new Unauthenticated({ reason: 'consent revoked' })
  const now = Date.now()
  if (!isLive(grant, now)) {
    await revokeClientGrant(env.AUTH_DB, principal.subject, principal.clientId, now)
    throw new Unauthenticated({ reason: 'grant_expired' })
  }
  return { ...principal, grant }
}

/**
 * No logging of auth request content; the provider owns its discovery/OAuth responses. The OpenID Connect provider is
 * built only for its own two routes.
 */
export const handleAuth = (request: Request, env: RuntimeEnv): Promise<Response> => {
  const path = new URL(request.url).pathname
  // API keys and workspaces are made, changed and ended only through the account APIs (ADRs 0081, 0089): none of
  // their plugins' own routes is served.
  if (path.startsWith(`${AUTH_BASE_PATH}/api-key/`) || path.startsWith(`${AUTH_BASE_PATH}/organization/`))
    return Promise.resolve(new Response('Not found', { status: 404 }))
  const provider = path.startsWith(`${AUTH_BASE_PATH}/`) && isOidcPath(path.slice(AUTH_BASE_PATH.length))
  return createAuth(env, env.AUTH_DB, { provider }).handler(request)
}

/** RFC 9728 metadata for /mcp, served at every `/.well-known/oauth-protected-resource…` path. */
export const resourceMetadata = (env: Pick<RuntimeEnv, 'APP_URL'>) =>
  protectedResourceMetadata(env.APP_URL, authIssuer(env.APP_URL))

/** The registered name of an inbound client, for display and its conversation label. */
export const clientName = async (clientId: string, env: RuntimeEnv): Promise<string | undefined> =>
  (
    await env.AUTH_DB.prepare('SELECT name FROM oauthClient WHERE clientId = ?')
      .bind(clientId)
      .first<{ name: string | null }>()
  )?.name ?? undefined
