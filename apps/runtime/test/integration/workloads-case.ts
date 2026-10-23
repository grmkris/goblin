import { expect } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CreateApiKeyTerms, CreatedApiKey, TrustedWorkloadView, presetFor } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { GITHUB, SWARMM } from '../workloads/issuer.ts'
import { person, signedIn } from './owner-requests.ts'

const Assertion = Schema.Struct({ assertion: Schema.String })
const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })

/** Real local Worker, auth D1 and agent: save trust as its owner, then call with fixture platform JWTs. */
export const workloadsCase = async (base: string) => {
  const who = await person(base)
  const agent = signedIn(base, who)
  const request = (path: string, init: RequestInit = {}) => agent.fetch(new Request(`https://agent${path}`, init))
  const workspace = who.workspace
  const grant = { name: 'Workload CI', terms: { ...presetFor('Workload CI', [workspace]), level: 'read' as const } }
  Schema.decodeUnknownSync(CreateApiKeyTerms)(grant)
  const keyResponse = await request('/api/keys', { method: 'POST', body: JSON.stringify(grant) })
  expect(keyResponse.status).toBe(201)
  const { key, secret } = Schema.decodeUnknownSync(CreatedApiKey)(await keyResponse.json())
  for (const issuer of [GITHUB, SWARMM]) {
    const subject = issuer === GITHUB ? 'repo:acme/worker:ref:refs/heads/dev' : 'swarmm:prod'
    const policyResponse = await request('/api/trusted-workloads', {
      method: 'POST',
      body: JSON.stringify({
        policy: {
          issuer,
          label: issuer === GITHUB ? 'GitHub CI' : 'Swarmm',
          claims: { aud: ['https://goblin.test'], sub: [subject] },
        },
        grantId: key.id,
        disableKeySecret: true,
      }),
    })
    expect(policyResponse.status).toBe(201)
    const policy = Schema.decodeUnknownSync(TrustedWorkloadView)(await policyResponse.json())
    const minted = await request(`/__test/workload-token?issuer=${encodeURIComponent(issuer)}`, {
      method: 'POST',
      body: '{}',
    })
    const { assertion } = Schema.decodeUnknownSync(Assertion)(await minted.json())
    const call = (token: string, path = '/api/access', method = 'GET') =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      })
    const read = await call(assertion)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ grantId: key.id, keyId: key.id, level: 'read' })
    expect((await call(secret)).status).toBe(401)
    const client = new Client({ name: 'native-workload', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${assertion}` } },
        }),
      )
      const access = await client.callTool({ name: 'access_read', arguments: {} })
      expect(access.isError).not.toBe(true)
      expect(access.structuredContent).toMatchObject({ grantId: key.id, keyId: key.id, level: 'read' })
    } finally {
      await client.close()
    }
    // Webhook delivery must never retain authority beyond a workload's policy/bearer.
    const subscribe = await fetch(`${base}/api/events/subscribe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'conversation.updated',
        delivery: { mode: 'webhook', url: 'https://receiver.example/hook', secret: 'a'.repeat(32) },
      }),
    })
    expect(subscribe.status).toBe(403)
    expect(await subscribe.json()).toMatchObject({ error: { reason: 'workload_webhook' } })
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    const exchange = () => fetch(`${base}/token`, { method: 'POST', body: form })
    const tokenResponse = await exchange()
    expect(tokenResponse.status).toBe(200)
    const token = Schema.decodeUnknownSync(Token)(await tokenResponse.json())
    expect(token.expires_in).toBeLessThanOrEqual(300)
    expect((await call(token.access_token)).status).toBe(200)
    expect((await call(token.access_token, '/api/personas', 'POST')).status).toBe(403)
    expect((await exchange()).status).toBe(400)
    const disabled = await request(`/api/trusted-workloads/${policy.id}/disable`, { method: 'POST' })
    expect(disabled.status).toBe(200)
    expect((await call(assertion)).status).toBe(401)
    expect((await call(token.access_token)).status).toBe(401)
  }
}
