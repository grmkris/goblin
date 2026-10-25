import { describe, expect, it } from 'vitest'
import { RESOURCE_SCOPES, challengeOf, mcpResource, protectedResourceMetadata } from '../../src/auth/resources.ts'

const APP = 'https://goblin.test'
const ISSUER = `${APP}/api/auth`
const METADATA = `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="goblin"`

describe('the /mcp resource (unit, ADRs 0024, 0086, 0122)', () => {
  it('is one resource whose metadata offers `goblin`, the one scope that reaches it (ADR 0114), and no sign-in scope', () => {
    expect(mcpResource(`${APP}/`)).toBe(`${APP}/mcp`)
    expect(RESOURCE_SCOPES).toEqual(['goblin'])
    expect(protectedResourceMetadata(APP, ISSUER)).toEqual({
      resource: `${APP}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['goblin'],
      resource_name: 'goblin',
    })
  })

  it('challenges with the metadata and the scope to ask for, and says invalid_token when a bearer was refused', () => {
    const missing = challengeOf(`${APP}/`)
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe(`Bearer ${METADATA}`)
    const refused = challengeOf(APP, { invalidToken: true })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe(`Bearer error="invalid_token", ${METADATA}`)
  })
})
