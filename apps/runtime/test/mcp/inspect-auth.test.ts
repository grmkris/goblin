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
        'goblin:agent',
        'goblin:topics',
        'goblin:conversations',
        'goblin:personas',
        'goblin:inspect',
        'goblin:transcripts',
        'goblin:setup',
        'goblin:routines',
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

  it('gives a token the caller scopes its consent maps to, each only as consented', () => {
    // Every power is its own switch (ADR 0098): asking the agent too, and the conversations in full apart from runs.
    expect(callerScopesOf(['openid', 'offline_access'])).toEqual([])
    expect(callerScopesOf(['goblin:agent', 'goblin:topics', 'goblin:personas'])).toEqual([
      'agent',
      'topics',
      'personas',
    ])
    expect(callerScopesOf(['goblin:inspect', 'goblin:inspect'])).toEqual(['inspect'])
    expect(callerScopesOf(['goblin:transcripts', 'goblin:setup', 'goblin:routines'])).toEqual([
      'transcripts',
      'setup',
      'routines',
    ])
    expect(callerScopesOf(['goblin:everything'])).toEqual([])
  })

  it('reads the scopes a standing consent grants, and none from a malformed one', () => {
    expect(grantedScopes({ scopes: '["openid","goblin:inspect"]' })).toEqual(['openid', 'goblin:inspect'])
    expect(grantedScopes({ scopes: null })).toEqual([])
    expect(grantedScopes({ scopes: 'goblin:inspect' })).toEqual([])
    expect(grantedScopes({ scopes: '{"goblin:inspect":true}' })).toEqual([])
    expect(grantedScopes({ scopes: '["openid",3]' })).toEqual(['openid'])
  })
})
