import { describe, expect, it } from 'vitest'
import { grantedScopes } from '../../src/auth/principal.ts'
import {
  MCP_SCOPES,
  callerScopesOf,
  challengeOf,
  mcpResource,
  protectedResourceMetadata,
} from '../../src/auth/resources.ts'

const APP = 'https://goblin.test'
const ISSUER = `${APP}/api/auth`

describe('the /mcp resource (unit, ADRs 0024, 0086)', () => {
  it('is one resource whose metadata offers each goblin scope', () => {
    expect(mcpResource(`${APP}/`)).toBe(`${APP}/mcp`)
    expect(protectedResourceMetadata(APP, ISSUER)).toEqual({
      resource: `${APP}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'goblin:topics',
        'goblin:conversations',
        'goblin:personas',
        'goblin:inspect',
      ],
      resource_name: 'goblin',
    })
  })

  it('challenges with the metadata and every scope, so a new connection asks for each one', () => {
    const challenge = challengeOf(`${APP}/`)
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    )
  })

  it('gives a token the caller scopes its consent maps to: asking always, the rest only as consented', () => {
    expect(callerScopesOf(['openid', 'offline_access'])).toEqual(['agent'])
    expect(callerScopesOf(['goblin:topics', 'goblin:personas'])).toEqual(['agent', 'topics', 'personas'])
    expect(callerScopesOf(['goblin:inspect', 'goblin:inspect'])).toEqual(['agent', 'inspect', 'transcripts'])
    expect(callerScopesOf(['goblin:everything'])).toEqual(['agent'])
  })

  it('reads the scopes a standing consent grants, and none from a malformed one', () => {
    expect(grantedScopes({ scopes: '["openid","goblin:inspect"]' })).toEqual(['openid', 'goblin:inspect'])
    expect(grantedScopes({ scopes: null })).toEqual([])
    expect(grantedScopes({ scopes: 'goblin:inspect' })).toEqual([])
    expect(grantedScopes({ scopes: '{"goblin:inspect":true}' })).toEqual([])
    expect(grantedScopes({ scopes: '["openid",3]' })).toEqual(['openid'])
  })
})
