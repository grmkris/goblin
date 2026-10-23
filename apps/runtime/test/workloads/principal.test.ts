import { Client, PrivateKeyJwtProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { exportJWK } from 'jose'
import { AccessSummary, presetFor } from '@goblin/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import * as Schema from 'effect/Schema'
import { createKey, revokeKey, updateKey, verifyKey } from '../../src/auth/api-keys.ts'
import { createOidcPolicy, disableOidcPolicy, listOidcPolicies, verifyWorkload } from '../../src/auth/oidc-workloads.ts'
import { grantById, termsOf } from '../../src/auth/grants.ts'
import { summaryOf } from '../../src/auth/consent-terms.ts'
import { makeOidcVerifier } from '../../src/auth/workload-verifier.ts'
import { verifyServerBearer } from '../../src/auth/workload-tokens.ts'
import { workerWith } from '../../src/http/worker.ts'
import { forwardedPrincipal } from '../../src/http/api/principal.ts'
import { Unauthenticated } from '../../src/http/errors.ts'
import { fake } from '../fake.ts'
import { APP, GITHUB, SWARMM, issuerFixture } from './issuer.ts'
import { authFixture } from './fixture.ts'

const close: (() => void)[] = []
afterEach(() => {
  for (const dispose of close.splice(0)) dispose()
})
const decodeAccess = Schema.decodeUnknownSync(AccessSummary)
const TokenReply = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
})
const decodeToken = Schema.decodeUnknownSync(TokenReply)
const policyOf = (issuer: string) => ({
  issuer,
  label: 'CI',
  claims:
    issuer === GITHUB
      ? {
          aud: [APP],
          sub: ['repo:acme/worker:ref:refs/heads/dev'],
          repository: ['acme/worker'],
          ref: ['refs/heads/dev'],
        }
      : { aud: [APP], sub: ['swarmm:prod'] },
})

const fixture = async (origin = GITHUB, disableKeySecret = false) => {
  const { db, env } = authFixture()
  close.push(() => db.close())
  const issuer = await issuerFixture(origin)
  const verify = makeOidcVerifier(issuer.fetch)
  const key = await createKey(env, 'w1', 'u1', { name: 'CI', terms: { ...presetFor('CI', ['w1']), level: 'read' } })
  const policy = await createOidcPolicy(env, 'w1', 'u1', {
    policy: policyOf(origin),
    grantId: key.key.id,
    disableKeySecret,
  })
  const seen: string[] = []
  Object.assign(env, {
    AGENTS: fake<RuntimeAgents>({
      getByName: (name) => {
        seen.push(name)
        return fake<ReturnType<RuntimeAgents['getByName']>>({
          fetch: async (request: RequestInfo | URL) => {
            const input = request instanceof Request ? request : new Request(request)
            const credential = forwardedPrincipal(input)?.credential
            if (credential === undefined) throw new Error('missing forwarded credential')
            const grant = await grantById(env.AUTH_DB, credential.grantId)
            if (grant === undefined) throw new Error('missing grant')
            return Response.json(summaryOf(APP, grant, await termsOf(env.AUTH_DB, grant)))
          },
        })
      },
    }),
  })
  const runtime = workerWith(verify)
  const call = (token: string, path = '/api/access', method = 'GET') =>
    runtime.fetch(
      new Request(`${APP}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    )
  const exchange = (assertion: string, extra: Record<string, string> = {}) =>
    runtime.fetch(
      new Request(`${APP}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, ...extra }),
      }),
      env,
    )
  return { db, env, issuer, verify, key, policy, seen, runtime, call, exchange }
}
type RuntimeAgents = import('../../src/env.ts').RuntimeEnv['AGENTS']

describe('workload trust through the Worker, real auth migrations, and official MCP client', () => {
  it.each([GITHUB, SWARMM])('admits a local %s assertion and preserves the server principal', async (origin) => {
    const f = await fixture(origin)
    const token = await f.issuer.token()
    const principal = await verifyWorkload(f.env, token, f.verify)
    expect(principal).toMatchObject({
      workspaceId: 'w1',
      credential: { kind: 'key', id: f.key.key.id, grantId: f.key.key.id, level: 'read' },
    })
    const response = await f.call(token)
    expect(response.status).toBe(200)
    expect(decodeAccess(await response.json())).toMatchObject({
      grantId: f.key.key.id,
      level: 'read',
      keyId: f.key.key.id,
    })
    expect(f.seen).toEqual(['w1'])
  })

  it('retires the static secret through Better Auth, while OIDC retains its grant and identity', async () => {
    const f = await fixture(SWARMM, true)
    await expect(verifyKey(f.env, f.key.secret)).rejects.toBeInstanceOf(Unauthenticated)
    expect((await f.call(await f.issuer.token())).status).toBe(200)
    expect(f.db.prepare('SELECT enabled FROM apikey WHERE id = ?').get(f.key.key.id)).toEqual({ enabled: 0 })
  })

  it('exchanges an assertion for a hashed, short-lived token, then calls HTTP and MCP', async () => {
    const f = await fixture()
    const assertion = await f.issuer.token()
    const response = await f.exchange(assertion)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const token = decodeToken(await response.json())
    expect(token).toMatchObject({ token_type: 'Bearer', scope: 'goblin' })
    expect(token.expires_in).toBeGreaterThan(0)
    expect(token.expires_in).toBeLessThanOrEqual(300)
    expect(JSON.stringify(f.db.prepare('SELECT * FROM workloadAccessToken').all())).not.toContain(token.access_token)
    expect((await f.call(token.access_token)).status).toBe(200)
    const provider = new PrivateKeyJwtProvider({
      clientId: 'local-ci',
      privateKey: await exportJWK(f.issuer.pair.privateKey),
      algorithm: 'ES256',
      expectedIssuer: `${APP}/workloads`,
    })
    provider.saveTokens(token)
    const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
      authProvider: provider,
      fetch: (input, init) => {
        const request = new Request(input, init)
        request.headers.set('host', new URL(request.url).host)
        return f.runtime.fetch(request, f.env)
      },
    })
    const client = new Client({ name: 'workload-test', version: '1' })
    try {
      await client.connect(transport)
      expect(client.getServerCapabilities()?.extensions).toHaveProperty(
        'io.modelcontextprotocol/oauth-client-credentials',
      )
      const result = await client.callTool({ name: 'access_read', arguments: {} })
      expect(JSON.stringify(result)).toContain(f.key.key.id)
    } finally {
      await client.close()
    }
    const replay = await f.exchange(assertion)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ error: 'invalid_grant', error_description: 'assertion-replayed' })
  })

  it('claims a jti once under concurrent exchanges and checks token expiry on every call', async () => {
    const f = await fixture()
    const assertion = await f.issuer.token()
    const responses = await Promise.all([f.exchange(assertion), f.exchange(assertion)])
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([200, 400])
    const accepted = responses.find((response) => response.status === 200)
    if (accepted === undefined) throw new Error('no accepted exchange')
    const token = decodeToken(await accepted.json()).access_token
    f.db.prepare('UPDATE workloadAccessToken SET expiresAt = 1').run()
    expect((await f.call(token)).status).toBe(401)
  })

  it('refuses scope escalation and applies grant narrowing to an already issued token', async () => {
    const f = await fixture()
    expect((await f.exchange(await f.issuer.token(), { scope: 'goblin setup' })).status).toBe(400)
    expect((await f.exchange(await f.issuer.token(), { resource: 'https://other.example/mcp' })).status).toBe(400)
    const token = decodeToken(await (await f.exchange(await f.issuer.token())).json()).access_token
    expect((await f.call(token, '/api/personas', 'POST')).status).toBe(403)
    expect(f.seen).toHaveLength(0)
    await updateKey(f.env, 'w1', 'u1', f.key.key.id, {
      terms: {
        ...presetFor('CI', ['w1']),
        level: 'manage',
        reach: {
          workspaces: 'list',
          origins: [],
          each: [
            {
              workspace: 'w1',
              topics: { kind: 'list', ids: ['2'] },
              personas: { kind: 'list', ids: [] },
              connections: { kind: 'list', ids: [] },
            },
          ],
        },
      },
    })
    const principal = await verifyServerBearer(f.env, token, f.verify)
    expect(principal.credential.ws).toMatchObject({ topics: 'list', personas: 'list', connections: 'list' })
  })

  it('refuses disabled/deleted policies and deleted grants for direct and exchanged bearers', async () => {
    const f = await fixture()
    const assertion = await f.issuer.token()
    const token = decodeToken(await (await f.exchange(assertion)).json()).access_token
    await disableOidcPolicy(f.env, 'w2', f.policy.id)
    expect((await f.call(assertion)).status).toBe(200)
    await disableOidcPolicy(f.env, 'w1', f.policy.id)
    expect((await f.call(assertion)).status).toBe(401)
    expect((await f.call(token)).status).toBe(401)
    f.db.prepare('DELETE FROM trustedWorkloadPolicy WHERE id = ?').run(f.policy.id)
    expect((await f.call(token)).status).toBe(401)
    expect(await listOidcPolicies(f.env, 'w1')).toEqual([])
    const second = await createOidcPolicy(f.env, 'w1', 'u1', {
      policy: policyOf(GITHUB),
      grantId: f.key.key.id,
      disableKeySecret: false,
    })
    expect((await f.exchange(assertion)).status).toBe(400)
    await revokeKey(f.env, 'w1', f.key.key.id)
    expect((await f.call(assertion)).status).toBe(401)
    expect(f.db.prepare('SELECT id FROM trustedWorkloadPolicy WHERE id = ?').get(second.id)).toBeUndefined()
  })

  it('refuses bad claims, expiry, signatures and unknown issuers on both HTTP and MCP with no anonymous fallback', async () => {
    const f = await fixture()
    const attacker = await issuerFixture()
    const tokens = [
      await f.issuer.token({ aud: 'other' }),
      await f.issuer.token({ sub: 'other' }),
      await f.issuer.token({ iat: 1, exp: 2 }),
      await attacker.token(),
      await f.issuer.token({ iss: 'https://unknown.example' }),
      'a.b.c',
    ]
    for (const token of tokens) {
      expect((await f.call(token)).status).toBe(401)
      expect((await f.call(token, '/mcp', 'POST')).status).toBe(401)
    }
    expect(f.seen).toHaveLength(0)
  })

  it('refuses foreign grants, private issuers, different audiences and ambiguous workspace matches', async () => {
    const f = await fixture()
    await expect(
      createOidcPolicy(f.env, 'w2', 'u2', { policy: policyOf(GITHUB), grantId: f.key.key.id, disableKeySecret: false }),
    ).rejects.toThrow()
    await expect(
      createOidcPolicy(f.env, 'w1', 'u1', {
        policy: { ...policyOf(GITHUB), issuer: 'https://localhost' },
        grantId: f.key.key.id,
        disableKeySecret: false,
      }),
    ).rejects.toThrow()
    const other = await createKey(f.env, 'w2', 'u2', { name: 'other', terms: presetFor('other', ['w2']) })
    await createOidcPolicy(f.env, 'w2', 'u2', {
      policy: policyOf(GITHUB),
      grantId: other.key.id,
      disableKeySecret: false,
    })
    const response = await f.call(await f.issuer.token())
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { reason: 'ambiguous-policy' } })
    expect(f.seen).toHaveLength(0)
  })
})
