import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { OidcFetch } from '../../src/auth/workload-verifier.ts'

export const APP = 'https://goblin.test'
export const GITHUB = 'https://token.actions.githubusercontent.com'
export const SWARMM = 'https://swarmm.example'

/** A local injected OIDC issuer: real ephemeral signatures, discovery and JWKS, with no network. */
export const issuerFixture = async (issuer = GITHUB, algorithm: 'ES256' | 'RS256' = 'ES256') => {
  const pair = await generateKeyPair(algorithm, { extractable: true })
  const kid = crypto.randomUUID()
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: algorithm, use: 'sig' }
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: OidcFetch = (url, init) => {
    calls.push({ url, init })
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Promise.resolve(Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` }))
    if (url === `${issuer}/.well-known/jwks.json`) return Promise.resolve(Response.json({ keys: [jwk] }))
    return Promise.resolve(new Response(null, { status: 404 }))
  }
  const token = (changes: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      iss: issuer,
      aud: APP,
      sub: issuer === GITHUB ? 'repo:acme/worker:ref:refs/heads/dev' : 'swarmm:prod',
      repository: 'acme/worker',
      ref: 'refs/heads/dev',
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
      ...changes,
    })
      .setProtectedHeader({ alg: algorithm, kid })
      .sign(pair.privateKey)
  }
  return { issuer, pair, kid, jwk, calls, fetch, token }
}
