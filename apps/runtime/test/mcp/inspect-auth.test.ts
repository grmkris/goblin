import { describe, expect, it } from 'vitest'
import { MCP_SCOPES, challengeOf, mcpResource, protectedResourceMetadata } from '../../src/auth/resources.ts'

const APP = 'https://goblin.test'
const ISSUER = `${APP}/api/auth`

describe('the /mcp resource (unit, ADRs 0024, 0086)', () => {
  it('is one resource whose metadata offers the sign-in scopes and `goblin`, the one scope that reaches it (ADR 0114)', () => {
    expect(mcpResource(`${APP}/`)).toBe(`${APP}/mcp`)
    expect(protectedResourceMetadata(APP, ISSUER)).toEqual({
      resource: `${APP}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'goblin'],
      resource_name: 'goblin',
    })
  })

  it('challenges with the metadata and the scopes to ask for', () => {
    const challenge = challengeOf(`${APP}/`)
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    )
  })
})
