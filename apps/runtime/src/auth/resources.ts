/**
 * goblin's one protected resource (ADRs 0024, 0086): `/mcp`. A client asks for the sign-in scopes, `offline_access` for
 * a refresh token, and `goblin`, the one scope that reaches goblin at all. What it may do there is its grant (ADR 0114),
 * which its person approves on the consent page and edits in Settings, never a scope: a change applies to its live
 * tokens at once.
 */
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'goblin'] as const

/**
 * Every server API key's prefix (ADR 0081). An inbound OAuth access token is a JWS, so a bearer with this prefix is
 * never one of those, and the edge and /mcp tell the two apart by it alone.
 */
export const KEY_PREFIX = 'gbk_'
/** A key's secret after its prefix: this many letters, the plugin's default length. */
export const KEY_LENGTH = 64
/** How much of a key's secret the plugin keeps in the clear (`start`, the prefix and 6 letters), to tell keys apart. */
export const KEY_START_LENGTH = 10

const METADATA_PATH = '/.well-known/oauth-protected-resource'
const base = (appUrl: string) => appUrl.replace(/\/$/u, '')

/** The canonical resource URL: the audience every token carries. */
export const mcpResource = (appUrl: string): string => `${base(appUrl)}/mcp`

export const protectedResourceMetadata = (appUrl: string, issuer: string) => ({
  resource: mcpResource(appUrl),
  authorization_servers: [issuer],
  bearer_methods_supported: ['header'],
  scopes_supported: [...MCP_SCOPES],
  resource_name: 'goblin',
})

/**
 * The 401 an unauthenticated request gets: where the metadata is, and the scopes to ask for, so a client's first
 * authorization asks for `goblin` and the consent page shows the grant it is to have.
 */
export const challengeOf = (appUrl: string): Response =>
  new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${base(appUrl)}${METADATA_PATH}/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    },
  })
