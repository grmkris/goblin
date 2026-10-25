import { Schema } from 'effect'
import { expect } from 'vitest'
import { DOCUMENT_CLIENT, MOVED_CLIENT, SCHEME_CLIENT } from './auth-fixture.ts'
import { APP, REDIRECT, RESOURCE, auth, authorize, browserOf, connect, register, token } from './auth-inspect.ts'
import { createHash } from 'node:crypto'
import { type Person, person } from './owner-requests.ts'

/** What the MCP authorization spec (2026-07-28) asks of goblin's authorization server, on the wire (ADR 0122). */

const Registration = Schema.Struct({
  client_id: Schema.String,
  application_type: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  dpop_bound_access_tokens: Schema.optional(Schema.Boolean),
})
const OAuthError = Schema.Struct({ error: Schema.String, error_description: Schema.optional(Schema.String) })
const Metadata = Schema.Struct({
  issuer: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  authorization_response_iss_parameter_supported: Schema.Boolean,
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
  dpop_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)),
})

/** A fresh address for each client that registers: the per-address limit on registration is not what is proven here. */
const freshIp = () =>
  `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:2`

/** A dynamic registration as a client sends it, unauthenticated, and its answer. */
const registration = async (base: string, who: Person, body: Record<string, unknown>) => {
  const response = await auth(base, who, '/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
    body: JSON.stringify({ client_name: 'protocol-fixture', token_endpoint_auth_method: 'none', ...body }),
  })
  const json: unknown = await response.json()
  return { status: response.status, json }
}

/** The payload of a JWS access token, undecoded by any key: the claims a resource server would read. */
const payloadOf = (jwt: string): Record<string, unknown> =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()),
  )

const mcpWith = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

/**
 * The authorization server documents offer S256, `iss`, metadata documents and no DPoP, at the discovery paths an
 * issuer with a path has (RFC 8414 §3.1 path-inserted; OpenID path-appended).
 */
async function metadataCase(base: string) {
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/api/auth/.well-known/openid-configuration']) {
    const response = await fetch(`${base}${path}`)
    expect(response.status, path).toBe(200)
    const document = Schema.decodeUnknownSync(Metadata)(await response.json())
    expect(document, path).toMatchObject({
      issuer: `${APP}/api/auth`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    })
    expect(document.dpop_signing_alg_values_supported, path).toBeUndefined()
  }
}

/**
 * Registration: redirects are localhost or https (a private-use scheme is refused), a client that says no type is
 * native when a redirect is http on loopback (Claude Code, VS Code), grants are narrowed to the two a public client
 * holds instead of refused, and no registration binds DPoP.
 */
async function registrationCase(base: string, who: Person) {
  const vscode = await registration(base, who, {
    redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    dpop_bound_access_tokens: true,
  })
  expect(vscode.status, JSON.stringify(vscode.json)).toBe(201)
  const registered = Schema.decodeUnknownSync(Registration)(vscode.json)
  expect(registered.application_type).toBe('native')
  expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token'])
  expect(registered.dpop_bound_access_tokens).not.toBe(true)
  const claudeCode = await registration(base, who, { redirect_uris: ['http://localhost:33418/callback'] })
  expect(claudeCode.status, JSON.stringify(claudeCode.json)).toBe(201)
  expect(Schema.decodeUnknownSync(Registration)(claudeCode.json).application_type).toBe('native')
  const web = await registration(base, who, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
  expect(web.status, JSON.stringify(web.json)).toBe(201)
  expect(Schema.decodeUnknownSync(Registration)(web.json).application_type).toBe('web')
  for (const uris of [
    ['cursor://anysphere.cursor-mcp/oauth/callback'],
    ['http://127.0.0.1:9/callback', 'cursor://anysphere.cursor-mcp/oauth/callback'],
    ['http://evil.example/callback'],
  ]) {
    const refused = await registration(base, who, { redirect_uris: uris, application_type: 'native' })
    expect(refused.status, uris.join()).toBe(400)
    expect(Schema.decodeUnknownSync(OAuthError)(refused.json).error).toBe('invalid_redirect_uri')
  }
}

/**
 * Authorization and tokens: a loopback redirect may change its port; every authorization asks `offline_access`, so a
 * client asking `goblin` alone gets a refresh token; a DPoP proof or thumbprint is ignored and the token is a plain
 * bearer without a confirmation; a bearer that is refused gets `invalid_token`.
 */
async function tokenCase(base: string, who: Person) {
  const clientId = await register(base, who)
  const varied = await authorize(base, who, clientId, {
    scope: 'goblin',
    redirect: 'http://127.0.0.1:50222/callback',
    query: { dpop_jkt: 'x'.repeat(43) },
    tokenHeaders: { dpop: 'not-a-proof' },
  })
  expect(varied.asked).toBe(true)
  expect(varied.askedScope).toBe('goblin offline_access')
  expect(varied.refresh).toBeDefined()
  expect(varied.tokenType.toLowerCase()).toBe('bearer')
  const claims = payloadOf(varied.access)
  expect(claims).not.toHaveProperty('cnf')
  expect(claims).toMatchObject({ aud: expect.anything(), azp: clientId })
  expect((await mcpWith(base, { authorization: `Bearer ${varied.access}` })).status).toBe(200)
  // A client that declares an empty scope still gets a refresh token: `offline_access` is asked for it.
  const refreshed = await token(base, who, {
    grant_type: 'refresh_token',
    refresh_token: varied.refresh ?? '',
    client_id: clientId,
    resource: RESOURCE,
  })
  expect(refreshed.refresh_token).toBeDefined()
  // Presented and refused: a garbage bearer, and a bearer whose client was revoked, say so.
  const garbage = await mcpWith(base, { authorization: 'Bearer not-a-token' })
  expect(garbage.status).toBe(401)
  expect(garbage.headers.get('www-authenticate')).toBe(
    `Bearer error="invalid_token", resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="goblin"`,
  )
  const revoked = await fetch(`${base}/api/clients/${clientId}`, { method: 'DELETE', headers: browserOf(who) })
  expect(revoked.status).toBe(200)
  const after = await mcpWith(base, { authorization: `Bearer ${refreshed.access_token}` })
  expect(after.status).toBe(401)
  expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"')
  // A private-use redirect is refused at authorization too, with no redirect to it.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
    scope: 'goblin',
    resource: RESOURCE,
    code_challenge: createHash('sha256').update('verifier').digest('base64url'),
    code_challenge_method: 'S256',
  })
  const refused = await auth(base, who, `/oauth2/authorize?${query.toString()}`, {
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  })
  expect(refused.status).toBe(400)
  expect(refused.headers.get('location')).toBeNull()
}

/** RFC 7009: revoking an unknown token, or one already revoked, answers 200; the token is dead either way. */
async function revocationCase(base: string, who: Person) {
  const clientId = await register(base, who)
  const granted = await authorize(base, who, clientId, { scope: 'goblin' })
  const revoke = (form: Record<string, string>) =>
    auth(base, who, '/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
    })
  expect((await revoke({ token: 'unknown-token', token_type_hint: 'refresh_token' })).status).toBe(200)
  expect((await revoke({ token: 'unknown-token' })).status).toBe(200)
  expect((await revoke({ token: granted.refresh ?? '' })).status).toBe(200)
  expect((await revoke({ token: granted.refresh ?? '' })).status).toBe(200)
  const dead = await auth(base, who, '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: granted.refresh ?? '',
      client_id: clientId,
      resource: RESOURCE,
    }).toString(),
  })
  expect(dead.status).toBe(400)
  expect(Schema.decodeUnknownSync(OAuthError)(await dead.json()).error).toBe('invalid_grant')
  // A JWT is not a token this endpoint revokes: it says so rather than claim it did (RFC 7009 §2.2.1).
  const jwt = await revoke({ token: granted.access, token_type_hint: 'access_token' })
  expect(jwt.status).toBe(400)
  expect(Schema.decodeUnknownSync(OAuthError)(await jwt.json()).error).toBe('unsupported_token_type')
}

/**
 * A Client ID Metadata Document is a client (ADR 0122): its https URL is its id, its document is fetched and kept, the
 * person consents to it by name and its token reaches /mcp. A document listing a private-use redirect gets nowhere, and
 * a document URL that redirects is not followed.
 */
export async function cimdCase(base: string) {
  const owner = await person(base)
  const granted = await authorize(base, owner, DOCUMENT_CLIENT, { scope: 'goblin' })
  expect(granted.asked).toBe(true)
  expect(granted.refresh).toBeDefined()
  const lookup = await auth(base, owner, `/oauth2/public-client?client_id=${encodeURIComponent(DOCUMENT_CLIENT)}`)
  expect(lookup.status).toBe(200)
  expect(await lookup.json()).toMatchObject({ client_name: 'Document Client', client_uri: 'https://client.test' })
  const client = await connect(base, granted.access)
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('access_read')
  } finally {
    await client.close()
  }
  // Signing in again needs no consent: the standing one covers the document client like any other.
  const again = await authorize(base, owner, DOCUMENT_CLIENT, { scope: 'goblin' })
  expect(again.asked).toBe(false)
  // The person's clients list it by the name its document gives, and revoking it ends its tokens.
  const listed = await fetch(`${base}/api/clients`, { headers: browserOf(owner) })
  expect(listed.status).toBe(200)
  expect(JSON.stringify(await listed.json())).toContain('Document Client')
  const revoked = await fetch(`${base}/api/clients/${encodeURIComponent(DOCUMENT_CLIENT)}`, {
    method: 'DELETE',
    headers: browserOf(owner),
  })
  expect(revoked.status, await revoked.clone().text()).toBe(200)
  expect((await mcpWith(base, { authorization: `Bearer ${again.access}` })).status).toBe(401)
  for (const [clientId, redirect] of [
    [SCHEME_CLIENT, 'cursor://anysphere.cursor-mcp/oauth/callback'],
    [MOVED_CLIENT, REDIRECT],
  ] as const) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'goblin',
      resource: RESOURCE,
      code_challenge: createHash('sha256').update('verifier').digest('base64url'),
      code_challenge_method: 'S256',
    })
    const refused = await auth(base, owner, `/oauth2/authorize?${query.toString()}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    expect(refused.status, clientId).toBeGreaterThanOrEqual(400)
    expect(refused.headers.get('location'), clientId).toBeNull()
  }
}

export async function protocolCase(base: string) {
  await metadataCase(base)
  const owner = await person(base)
  await registrationCase(base, owner)
  await tokenCase(base, owner)
  await revocationCase(base, owner)
}
