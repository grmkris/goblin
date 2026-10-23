import { describe, expect, it, afterEach, vi } from 'vitest'
import { makeOidcVerifier } from '../../src/auth/workload-verifier.ts'
import { APP, GITHUB, issuerFixture } from './issuer.ts'

const policy = { issuer: GITHUB, claims: { aud: [APP], repository: ['acme/worker'], ref: ['refs/heads/dev'] } }
afterEach(() => vi.useRealTimers())

describe('OIDC UI verification through local discovery and ephemeral signatures', () => {
  it.each(['ES256', 'RS256'] as const)('verifies %s and reuses discovery and JWKS', async (algorithm) => {
    const issuer = await issuerFixture(GITHUB, algorithm)
    const verify = makeOidcVerifier(issuer.fetch)
    expect((await verify(await issuer.token(), [policy])).ok).toBe(true)
    expect((await verify(await issuer.token(), [policy])).ok).toBe(true)
    expect(issuer.calls.map(({ url }) => url)).toEqual([
      `${GITHUB}/.well-known/openid-configuration`,
      `${GITHUB}/.well-known/jwks.json`,
    ])
    expect(issuer.calls.every(({ init }) => init.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(
      true,
    )
  })

  it.each([
    ['wrong audience', { aud: 'https://elsewhere.example' }, 'claims-mismatch'],
    ['wrong repository', { repository: 'attacker/worker' }, 'claims-mismatch'],
    ['wrong branch', { ref: 'refs/heads/prod' }, 'claims-mismatch'],
    ['expired', { iat: 1, exp: 2 }, 'invalid-token'],
    ['too long', { exp: Math.floor(Date.now() / 1000) + 3600 }, 'invalid-token'],
    ['future issued', { iat: Math.floor(Date.now() / 1000) + 60 }, 'invalid-token'],
    ['missing expiry', { exp: undefined }, 'invalid-token'],
    ['unknown issuer', { iss: 'https://unknown.example' }, 'unknown-issuer'],
  ] as const)('refuses %s', async (_name, changes, code) => {
    const issuer = await issuerFixture()
    const result = await makeOidcVerifier(issuer.fetch)(await issuer.token(changes), [policy])
    expect(result).toEqual({ ok: false, code })
  })

  it('refuses absent/malformed tokens, invalid policies and unknown issuers without fetching', async () => {
    const issuer = await issuerFixture()
    const verify = makeOidcVerifier(issuer.fetch)
    expect(await verify(undefined, [policy])).toEqual({ ok: false, code: 'missing-token' })
    expect(await verify('a.b.c', [policy])).toEqual({ ok: false, code: 'malformed-token' })
    expect(await verify(await issuer.token(), [])).toEqual({ ok: false, code: 'unknown-issuer' })
    expect(await verify(await issuer.token(), [{ ...policy, claims: {} }])).toEqual({
      ok: false,
      code: 'invalid-policy',
    })
    expect(issuer.calls).toHaveLength(0)
  })

  it('refuses a valid-looking JWT signed with a different key, and ambiguous trust', async () => {
    const trusted = await issuerFixture()
    const attacker = await issuerFixture()
    const verify = makeOidcVerifier(trusted.fetch)
    expect(await verify(await attacker.token(), [policy])).toEqual({ ok: false, code: 'invalid-token' })
    expect(await verify(await trusted.token(), [policy, { ...policy }])).toEqual({
      ok: false,
      code: 'ambiguous-policy',
    })
  })

  it('accepts audience arrays by exact intersection; never coerces numbers or wildcard strings', async () => {
    const issuer = await issuerFixture()
    const verify = makeOidcVerifier(issuer.fetch)
    expect((await verify(await issuer.token({ aud: ['other', APP] }), [policy])).ok).toBe(true)
    expect(await verify(await issuer.token({ repository: 123 }), [policy])).toEqual({
      ok: false,
      code: 'claims-mismatch',
    })
    expect(await verify(await issuer.token(), [{ ...policy, claims: { aud: [APP], repository: ['acme/*'] } }])).toEqual(
      { ok: false, code: 'claims-mismatch' },
    )
  })

  it('refuses non-https/private issuers, redirects, large discovery, issuer mismatch and cross-origin JWKS', async () => {
    for (const origin of [
      'http://issuer.example',
      'https://127.0.0.1',
      'https://localhost',
      'https://secret.internal',
    ]) {
      const issuer = await issuerFixture(origin)
      const result = await makeOidcVerifier(issuer.fetch)(await issuer.token(), [{ ...policy, issuer: origin }])
      expect(result).toEqual({ ok: false, code: 'invalid-policy' })
      expect(issuer.calls).toHaveLength(0)
    }
    const issuer = await issuerFixture()
    for (const response of [
      new Response(null, { status: 302, headers: { location: 'http://localhost' } }),
      new Response(' '.repeat(65_537)),
      Response.json({ issuer: 'https://other.example', jwks_uri: `${GITHUB}/keys` }),
      Response.json({ issuer: GITHUB, jwks_uri: 'https://other.example/keys' }),
      Response.json({ issuer: GITHUB, jwks_uri: 'http://issuer.example/keys' }),
    ]) {
      expect(await makeOidcVerifier(() => Promise.resolve(response))(await issuer.token(), [policy])).toEqual({
        ok: false,
        code: 'discovery-failed',
      })
    }
  })

  it('backs off failed discovery and refreshes both caches after their TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const issuer = await issuerFixture()
    let failing = true
    let calls = 0
    const verify = makeOidcVerifier((url, init) => {
      calls++
      return failing ? Promise.resolve(new Response(null, { status: 503 })) : issuer.fetch(url, init)
    })
    expect(await verify(await issuer.token(), [policy])).toEqual({ ok: false, code: 'discovery-failed' })
    failing = false
    expect(await verify(await issuer.token(), [policy])).toEqual({ ok: false, code: 'discovery-failed' })
    expect(calls).toBe(1)
    vi.setSystemTime(Date.now() + 10_001)
    expect((await verify(await issuer.token(), [policy])).ok).toBe(true)
    vi.setSystemTime(Date.now() + 300_001)
    expect((await verify(await issuer.token(), [policy])).ok).toBe(true)
    expect(calls).toBe(5)
  })
})
