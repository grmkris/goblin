import type { CallerScope } from '@goblin/contracts'

/**
 * goblin's one protected resource (ADRs 0024, 0086): `/mcp`. A client asks for the sign-in scopes and the `goblin:*`
 * scopes it wants; the owner's consent decides each one, and a token holds only what the consent still grants.
 */
const INSPECT_SCOPE = 'goblin:inspect'

/**
 * What each `goblin:*` scope lets an OAuth client of the owner do, as the caller scopes owner admission checks. Every
 * consented client may ask the agent in main (`agent`); `goblin:inspect` reads how chats ran and the conversations in
 * full.
 */
const GRANTS: Readonly<Record<string, readonly CallerScope[]>> = {
  'goblin:topics': ['topics'],
  'goblin:conversations': ['conversations'],
  'goblin:personas': ['personas'],
  [INSPECT_SCOPE]: ['inspect', 'transcripts'],
}

/** What a client may ask for: `offline_access` earns a refresh token, each `goblin:*` scope what `GRANTS` says. */
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access', ...Object.keys(GRANTS)] as const

/** The caller scopes a token's standing scopes give it (ADR 0086). */
export const callerScopesOf = (scopes: readonly string[]): readonly CallerScope[] => [
  'agent',
  ...new Set(scopes.flatMap((scope) => GRANTS[scope] ?? [])),
]

/**
 * Every server API key's prefix (ADR 0081). An inbound OAuth access token is a JWS, so a bearer with this prefix is
 * never one of those, and the edge and /mcp tell the two apart by it alone.
 */
export const KEY_PREFIX = 'gbk_'

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
 * authorization already asks for every `goblin:*` scope and the consent page offers each one.
 */
export const challengeOf = (appUrl: string): Response =>
  new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${base(appUrl)}${METADATA_PATH}/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    },
  })
