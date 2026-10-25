import { describe, expect, it } from 'vitest'
import {
  guardAuthorization,
  guardRegistration,
  isAllowedRedirectUri,
  isDiscoveryPath,
  manualRedirects,
  withoutDpopMetadata,
  withoutDpopProof,
} from '../../src/auth/protocol.ts'
import { signupAllowed, signupMode } from '../../src/auth/signup.ts'
import { clientFromClaims } from '../../src/auth/principal.ts'

describe('inbound client claims (unit)', () => {
  const expected = { issuer: 'https://dev.example/api/auth', resource: 'https://dev.example/mcp', now: 100 }
  const valid = {
    iss: expected.issuer,
    sub: 'owner',
    azp: 'cli',
    aud: expected.resource,
    exp: 101,
    scope: 'openid',
  }
  const reason = (claims: object) => {
    try {
      clientFromClaims(claims, expected)
      return 'accepted'
    } catch (error) {
      // expected: the test asserts on the reason the claims were refused
      return error instanceof Error && 'reason' in error ? error.reason : 'unknown'
    }
  }
  it('accepts our issuer, audience and an unexpired token', () => {
    expect(clientFromClaims(valid, expected)).toEqual({
      clientId: 'cli',
      subject: 'owner',
      expiresAt: 101,
    })
  })
  it('rejects foreign issuers, other audiences, expiry and sender-constrained tokens', () => {
    expect(reason({ ...valid, iss: 'https://evil' })).toBe('issuer')
    expect(reason({ ...valid, aud: 'https://dev.example/other' })).toBe('audience')
    expect(reason({ ...valid, exp: 100 })).toBe('expired')
    expect(reason({ ...valid, azp: undefined })).toBe('client')
    // A token names no workspace (ADR 0097): the consent's reach decides, on every call, and a claim of one is ignored.
    const named = { ...valid, workspace: 'w1' }
    expect(clientFromClaims(named, expected)).not.toHaveProperty('workspaceId')
    expect(reason({ ...valid, cnf: { jkt: 'x' } })).toBe('sender-constrained tokens are not supported')
  })
})

/** What a refused registration or authorization answers: the OAuth error, or `accepted`. */
const outcome = (run: () => void): string => {
  try {
    run()
    return 'accepted'
  } catch (error) {
    // expected: the test asserts on the OAuth error the guard refuses with
    return error instanceof Error && 'body' in error ? JSON.stringify(error.body) : 'unknown'
  }
}

describe('what the MCP authorization spec asks of registration and authorization (unit, ADR 0122)', () => {
  it('allows a redirect URI that is localhost or https, and nothing else', () => {
    for (const uri of [
      'http://localhost:33418/callback',
      'http://127.0.0.1:9/cb',
      'http://[::1]:7/cb',
      'https://claude.ai/api/mcp/auth_callback',
      'https://vscode.dev/redirect',
    ])
      expect(isAllowedRedirectUri(uri), uri).toBe(true)
    for (const uri of [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'com.example.app:/callback',
      'http://evil.example/cb',
      'http://localhost.evil.example/cb',
      'not a uri',
      42,
    ])
      expect(isAllowedRedirectUri(uri), String(uri)).toBe(false)
  })
  it('refuses a registration with a private-use scheme, narrows its grants and binds no DPoP', () => {
    const cursor = { redirect_uris: ['http://127.0.0.1:9/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'] }
    expect(outcome(() => guardRegistration(cursor))).toContain('"invalid_redirect_uri"')
    const vscode = {
      redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      dpop_bound_access_tokens: true,
    }
    expect(outcome(() => guardRegistration(vscode))).toBe('accepted')
    expect(vscode).toEqual({
      redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
    })
    const confidential = { redirect_uris: ['https://app.example/cb'], grant_types: ['client_credentials'] }
    guardRegistration(confidential)
    expect(confidential.grant_types).toEqual([])
    // A body without the fields is left alone, as is anything that is not a body.
    const bare = { client_name: 'x' }
    guardRegistration(bare)
    expect(bare).toEqual({ client_name: 'x' })
    guardRegistration(undefined)
  })
  it('refuses an authorization to a private-use redirect, asks offline_access and drops a DPoP thumbprint', () => {
    expect(
      outcome(() =>
        guardAuthorization({ redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback', scope: 'goblin' }),
      ),
    ).toContain('"invalid_request"')
    const asked = { redirect_uri: 'http://127.0.0.1:50222/callback', scope: 'goblin', dpop_jkt: 'x'.repeat(43) }
    guardAuthorization(asked)
    expect(asked).toEqual({ redirect_uri: 'http://127.0.0.1:50222/callback', scope: 'goblin offline_access' })
    const already = { scope: 'openid offline_access goblin' }
    guardAuthorization(already)
    expect(already.scope).toBe('openid offline_access goblin')
    const empty = { scope: '' }
    guardAuthorization(empty)
    expect(empty.scope).toBe('offline_access')
    // No scope at all keeps the client's registered scopes, which hold it.
    const none = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }
    guardAuthorization(none)
    expect(none).not.toHaveProperty('scope')
  })
  it("asks the metadata fetch for manual redirects, which workerd has where the plugin asks 'error'", async () => {
    const seen: RequestInit[] = []
    const fetcher = manualRedirects((_, init) => {
      seen.push(init ?? {})
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }))
    })
    const answer = await fetcher('https://client.test/cimd.json', {
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
    expect(seen).toEqual([{ redirect: 'manual', headers: { accept: 'application/json' } }])
    expect([answer.status, answer.redirected]).toEqual([302, false])
  })
  it('takes the DPoP proof off a token request and the algorithms off a discovery document', async () => {
    const proven = new Request('https://goblin.test/api/auth/oauth2/token', {
      method: 'POST',
      headers: { dpop: 'proof', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token',
    })
    const bearer = withoutDpopProof(proven)
    expect(bearer.headers.has('dpop')).toBe(false)
    expect(bearer.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(await bearer.text()).toBe('grant_type=refresh_token')
    const plain = new Request('https://goblin.test/api/auth/oauth2/token', { method: 'POST' })
    expect(withoutDpopProof(plain)).toBe(plain)
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/openid-configuration',
    ])
      expect(isDiscoveryPath(path), path).toBe(true)
    expect(isDiscoveryPath('/api/auth/oauth2/token')).toBe(false)
    const document = { issuer: 'https://goblin.test/api/auth', dpop_signing_alg_values_supported: ['ES256'] }
    const stripped = await withoutDpopMetadata(
      Response.json(document, { headers: { 'cache-control': 'public, max-age=60' } }),
    )
    expect(await stripped.json()).toEqual({ issuer: 'https://goblin.test/api/auth' })
    expect(stripped.headers.get('cache-control')).toBe('public, max-age=60')
    const refused = new Response('nope', { status: 404 })
    expect(await withoutDpopMetadata(refused)).toBe(refused)
    const head = new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })
    expect(await withoutDpopMetadata(head)).toBe(head)
  })
})

describe('sign-up modes (unit)', () => {
  it('admits everyone when open, only the matching code on invite, and no one when closed or unset', () => {
    expect(signupAllowed('open', '', '')).toBe(true)
    expect(signupAllowed('invite', 'let-me-in-2026', 'let-me-in-2026')).toBe(true)
    expect(signupAllowed('invite', 'let-me-in-2026', 'let-me-in-2025')).toBe(false)
    expect(signupAllowed('invite', 'let-me-in-2026', '')).toBe(false)
    // An invite mode without a configured code must not turn into "any empty header passes".
    expect(signupAllowed('invite', '', '')).toBe(false)
    expect(signupAllowed('closed', 'let-me-in-2026', 'let-me-in-2026')).toBe(false)
    expect([signupMode('open'), signupMode('invite'), signupMode(undefined), signupMode('OPEN')]).toEqual([
      'open',
      'invite',
      'closed',
      'closed',
    ])
  })
})
