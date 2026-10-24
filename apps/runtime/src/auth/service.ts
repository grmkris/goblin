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
 * A verified access token: an OAuth client acting for a person, with the grant they gave it, or an installed app's own
 * (ADR 0118), whose subject is its client and whose grants are its installations' (`installs.ts`).
 */
export type VerifiedToken =
  | (ClientPrincipal & { readonly kind: 'client'; readonly grant: GrantRecord })
  | (ClientPrincipal & { readonly kind: 'app' })

/**
 * An inbound access token: a signature from our own JWKS (read locally, no self-fetch), our issuer and /mcp audience
 * and an enabled client. Then, for a token whose subject is its own client (the client_credentials grant), that the
 * client is an app a workspace registered (ADR 0118); for any other, the person's standing consent to the client
 * (ADR 0097: a consent names no workspace) and the live grant they gave it (ADR 0114). The token's scopes count for
 * nothing: what it may do is a grant, read on every call, so changing it applies to the live token at once and revoking
 * or uninstalling ends it. A client grant past its end ends the consent and the client's refresh tokens with it
 * (`grant_expired`), so the next sign-in asks again, pre-filled with the same terms.
 */
export const verifyAccessToken = async (token: string, env: RuntimeEnv): Promise<VerifiedToken> => {
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
  if (principal.subject === principal.clientId) {
    // No person: an app's own token. Only an app a workspace registered may hold one; what it reaches is its
    // installations, which the caller reads.
    const app = await env.AUTH_DB.prepare('SELECT 1 AS present FROM "app" WHERE "clientId" = ?')
      .bind(principal.clientId)
      .first<{ present: number }>()
    if (app === null) throw new Unauthenticated({ reason: 'client' })
    return { ...principal, kind: 'app' }
  }
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
  return { ...principal, kind: 'client', grant }
}

/**
 * Better Auth's own OAuth client management (ADR 0118): goblin registers, rotates and ends the clients apps are through
 * its account API, so none of these is served. Registration (`/oauth2/register`), the consent page's reads and the
 * OAuth flow itself are.
 */
const CLIENT_ROUTES: ReadonlySet<string> = new Set([
  '/oauth2/create-client',
  '/oauth2/update-client',
  '/oauth2/delete-client',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/client/rotate-secret',
])

/**
 * No logging of auth request content; the provider owns its discovery/OAuth responses. The OpenID Connect provider is
 * built only for its own two routes.
 */
export const handleAuth = (request: Request, env: RuntimeEnv): Promise<Response> => {
  const path = new URL(request.url).pathname
  // API keys, workspaces and apps are made, changed and ended only through the account APIs (ADRs 0081, 0089, 0118):
  // none of their plugins' own routes is served.
  if (
    path.startsWith(`${AUTH_BASE_PATH}/api-key/`) ||
    path.startsWith(`${AUTH_BASE_PATH}/organization/`) ||
    path.startsWith(`${AUTH_BASE_PATH}/admin/`) ||
    CLIENT_ROUTES.has(path.slice(AUTH_BASE_PATH.length))
  )
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
