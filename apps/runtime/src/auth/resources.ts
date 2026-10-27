/**
 * goblin's one protected resource (ADRs 0024, 0086): `/mcp`. What the authorization server offers a client: the sign-in
 * scopes, `offline_access` for a refresh token (which every authorization asks for, `protocol.ts`), and `goblin`, the one
 * scope that reaches goblin at all. What it may do there is its grant (ADR 0114), which its person approves on the
 * consent page and edits in Settings, never a scope: a change applies to its live tokens at once.
 */
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'goblin'] as const
/**
 * What the resource itself names, in its metadata and its 401 (ADR 0122): `goblin` alone. The identity and refresh
 * scopes are the authorization server's to offer (RFC 9728 §3.2; the spec says a challenge SHOULD NOT name
 * `offline_access`).
 */
export const RESOURCE_SCOPES = ['goblin'] as const

const METADATA_PATH = '/.well-known/oauth-protected-resource'
const base = (appUrl: string) => appUrl.replace(/\/$/u, '')

/** The canonical resource URL: the audience every token carries. */
export const mcpResource = (appUrl: string): string => `${base(appUrl)}/mcp`

export const protectedResourceMetadata = (appUrl: string, issuer: string) => ({
  resource: mcpResource(appUrl),
  authorization_servers: [issuer],
  bearer_methods_supported: ['header'],
  scopes_supported: [...RESOURCE_SCOPES],
  resource_name: 'goblin',
})

/**
 * The 401 a request without a usable token gets: where the metadata is, and the scope to ask for, so a client's first
 * authorization asks for `goblin` and the consent page shows the grant it is to have. A bearer that was presented and
 * refused (expired, revoked, another audience) says so with `error="invalid_token"` (RFC 6750 §3.1), which is what
 * tells a client to sign in again rather than give up.
 */
export const challengeOf = (appUrl: string, refused: { readonly invalidToken: boolean } = { invalidToken: false }) =>
  new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer ${refused.invalidToken ? 'error="invalid_token", ' : ''}resource_metadata="${base(appUrl)}${METADATA_PATH}/mcp", scope="${RESOURCE_SCOPES.join(' ')}"`,
    },
  })
