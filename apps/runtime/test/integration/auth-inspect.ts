import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InspectConversations } from '@goblin/contracts/inspect'
import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { type Person, call, keyBody, person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const REDIRECT = 'http://127.0.0.1:9/callback'
const RESOURCE = `${APP}/mcp`
const SIGN_IN_SCOPES = 'openid profile email offline_access'
/** What a client asks for since ADR 0114: the sign-in scopes and `goblin`; what it may do is its grant. */
const ALL_SCOPES = `${SIGN_IN_SCOPES} goblin`
const Registered = Schema.Struct({ client_id: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String) })
const Redirect = Schema.Struct({ url: Schema.optional(Schema.String), redirect_uri: Schema.optional(Schema.String) })

type Grant = { readonly access: string; readonly refresh: string | undefined; readonly asked: boolean }

type AuthInit = { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string }
const auth = (base: string, who: Person, path: string, init: AuthInit = {}) =>
  fetch(`${base}/api/auth${path}`, {
    redirect: 'manual',
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: { cookie: who.cookie, origin: APP, 'cf-connecting-ip': who.ip, ...init.headers },
  })

/** Where an authorize or consent step sends the browser: a redirect, or the provider's JSON `{ url }`. */
async function next(response: Response): Promise<URL> {
  const location = response.headers.get('location')
  if (location !== null) return new URL(location, APP)
  const body = Schema.decodeUnknownSync(Redirect)(await response.json())
  return new URL(body.url ?? body.redirect_uri ?? '', APP)
}

/** Dynamic registration as Claude Code makes it: no scope, so the client may ask for every /mcp scope. */
async function register(base: string, who: Person): Promise<string> {
  const registered = await auth(base, who, '/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'inspect-fixture',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  expect(registered.status, await registered.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Registered)(await registered.json()).client_id
}

/** A grant's terms as the consent page and Settings send them (ADR 0114). */
type Terms = {
  readonly level: 'read' | 'write' | 'manage'
  readonly extras?: readonly ('setup' | 'routines' | 'inspect')[]
  /** The workspaces it reaches: all of the person's, or these, each with every Topic unless `topics` lists some. */
  readonly workspaces?: 'all' | readonly string[]
  readonly topics?: readonly string[]
}

/** `terms` for `who`, as the grant editor writes them: every Persona and connection, until revoked. */
const termsOf = (who: Person, terms: Terms) => ({
  name: 'inspect-fixture',
  level: terms.level,
  extras: terms.extras ?? [],
  lifetime: 'never',
  reach: {
    workspaces: terms.workspaces === 'all' ? 'all' : 'list',
    each: (terms.workspaces === 'all' ? [] : (terms.workspaces ?? [who.workspace])).map((workspace) => ({
      workspace,
      topics: terms.topics === undefined ? { kind: 'all' } : { kind: 'list', ids: terms.topics },
      personas: { kind: 'all' },
      connections: { kind: 'all' },
    })),
    origins: [],
  },
})

const browserOf = (who: Person) => ({
  cookie: who.cookie,
  origin: APP,
  'x-goblin-csrf': '1',
  'cf-connecting-ip': who.ip,
  'content-type': 'application/json',
})
const GrantSaved = Schema.Struct({ grantId: Schema.String })

/**
 * What the consent page does before the consent itself, and Settings does later (ADR 0114): the grant the person gives
 * the client, which a live token follows at once. Its id.
 */
async function grantOf(base: string, who: Person, clientId: string, terms: Terms): Promise<string> {
  const set = await fetch(`${base}/api/clients/${clientId}/grant`, {
    method: 'PUT',
    headers: browserOf(who),
    body: JSON.stringify({ terms: termsOf(who, terms) }),
  })
  expect(set.status, await set.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(GrantSaved)(await set.json()).grantId
}

type Authorization = {
  readonly scope: string
  /** Force the consent page (`prompt=consent`) even when the standing consent covers the request. */
  readonly prompt?: 'consent'
  /** The grant the consent page gives it (ADR 0114); `write` over the person's own workspace by default. */
  readonly terms?: Terms
}

/** One sign-in of a registered client to /mcp: authorize, the consent page when the owner must answer, token. */
async function authorize(base: string, who: Person, clientId: string, request: Authorization): Promise<Grant> {
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: request.scope,
    resource: RESOURCE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'fixture',
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  })
  let landing = await next(
    await auth(base, who, `/oauth2/authorize?${query.toString()}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }),
  )
  const asked = landing.pathname === '/consent'
  if (asked) {
    // What the consent page reads to say what the client asks for.
    expect(landing.searchParams.get('scope')).toBe(request.scope)
    expect(landing.searchParams.getAll('resource')).toEqual([RESOURCE])
    await grantOf(base, who, clientId, request.terms ?? { level: 'write' })
    const consented = await auth(base, who, '/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: landing.search.slice(1) }),
    })
    expect(consented.status, await consented.clone().text()).toBe(200)
    landing = await next(consented)
  }
  const code = landing.searchParams.get('code') ?? ''
  expect(code, landing.href).not.toBe('')
  const tokens = await token(base, who, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  })
  return { access: tokens.access_token, refresh: tokens.refresh_token, asked }
}

async function token(base: string, who: Person, form: Record<string, string>) {
  const response = await auth(base, who, '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(Tokens)(await response.json())
}

/** An MCP client of /mcp with a bearer token, through the real Worker. */
async function connect(base: string, access: string) {
  const client = new Client({ name: 'inspect-fixture', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch: (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('authorization', `Bearer ${access}`)
        return fetch(input, { ...init, headers: sent })
      },
    }),
  )
  return client
}

/** The tools /mcp lists for a token. */
async function toolsOf(base: string, access: string): Promise<readonly string[]> {
  const client = await connect(base, access)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}
const inspection = (tools: readonly string[]) => tools.filter((name) => name.startsWith('inspect_'))
/** The tools that manage the owner's Topics, chats and Personas (ADR 0086), sorted. */
const MANAGEMENT = [
  'conversation_entries',
  'conversation_send',
  'conversation_stop',
  'models_list',
  'persona_create',
  'persona_get',
  'persona_list',
  'persona_update',
  'thread_start',
  'topic_create',
  'topic_get',
  'topic_list',
  'topic_set_setup',
  'topic_update',
]
const management = (tools: readonly string[]) => tools.filter((name) => MANAGEMENT.includes(name)).toSorted()

/** A key of the owner's (ADR 0081) whose grant is `level` with `extras` over everything, as its id and secret. */
async function ownerKey(base: string, who: Person, level: 'read' | 'manage', extras: readonly 'inspect'[] = []) {
  const made = await fetch(`${base}/w/${who.slug}/api/keys`, {
    method: 'POST',
    headers: browserOf(who),
    body: JSON.stringify(keyBody(who, `service-${level}`, { level, extras })),
  })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Schema.Struct({ key: Schema.Struct({ id: Schema.String }), secret: Schema.String }))(
    await made.json(),
  )
}

/** A Persona one of the owner's own API keys made (ADR 0081), by its name. */
async function keyMadePersona(base: string, who: Person): Promise<string> {
  const { secret } = await ownerKey(base, who, 'manage')
  const persona = await fetch(`${base}/api/personas`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Keymade',
      avatar: { glyph: 'K', hue: 10 },
      role: 'Made by a key',
      instructions: 'Be brief.',
      operationId: 'service:persona:1',
    }),
  })
  expect(persona.status, await persona.clone().text()).toBe(201)
  return 'Keymade'
}
const INSPECTION = [
  'inspect_conversations',
  'inspect_conversation',
  'inspect_turns',
  'inspect_turn',
  'inspect_problems',
  'inspect_flows',
  'inspect_details',
]

/** One resource: every metadata path names /mcp and offers `goblin`; the 401 asks for it. */
async function discoveryCase(base: string) {
  for (const path of ['', '/mcp', '/mcp/inspect'])
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource${path}`)).json(), path).toMatchObject({
      resource: RESOURCE,
      scopes_supported: ALL_SCOPES.split(' '),
    })
  const challenge = await fetch(`${base}/mcp`, { method: 'POST' })
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="${ALL_SCOPES}"`,
  )
  // The first cut's separate endpoints are gone (ADR 0024 amendments).
  expect((await fetch(`${base}/mcp/inspect`, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`${base}/mcp/operator`, { method: 'POST' })).status).toBe(404)
}

/** The access summary `access_read` answers: its grant, level and widening link. */
const Summary = Schema.Struct({ grantId: Schema.String, level: Schema.String, widenUrl: Schema.String })
const Refused = Schema.Struct({ _tag: Schema.Literal('AccessInsufficient'), widenUrl: Schema.String })

/**
 * ADRs 0024, 0086 and 0114 end to end on the real Worker, D1 auth store and agents: one /mcp, whose tools a client
 * gets by its grant's level and extras, which its person changes in Settings and its live token follows at once; a
 * call its grant does not cover answers `access_insufficient` with a widening link that works.
 */
export async function inspectAuthCase(base: string) {
  await discoveryCase(base)
  const owner = await person(base)
  const clientId = await register(base, owner)

  // A grant that only reads: no sends, no inspection; but its own access to read.
  const reading = await authorize(base, owner, clientId, { scope: ALL_SCOPES, terms: { level: 'read' } })
  expect(reading.asked).toBe(true)
  expect(reading.refresh).toBeDefined()
  const readTools = await toolsOf(base, reading.access)
  expect(readTools).toEqual(expect.arrayContaining(['access_read', 'topic_list', 'persona_get', 'workspace_list']))
  expect(inspection(readTools)).toEqual([])
  expect(readTools).not.toContain('ask_agent')
  expect(readTools).not.toContain('conversation_send')

  // Settings widens it: the same live token now lists inspection and management, without signing in again.
  const grantId = await grantOf(base, owner, clientId, { level: 'manage', extras: ['setup', 'routines', 'inspect'] })
  const client = await connect(base, reading.access)
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(inspection(names)).toEqual(INSPECTION)
    expect(management(names)).toEqual(MANAGEMENT)
    const access = await client.callTool({ name: 'access_read', arguments: {} })
    expect(Schema.decodeUnknownSync(Summary)(access.structuredContent)).toMatchObject({ grantId, level: 'manage' })
    // Every Persona of the workspace: one of the owner's keys made is the client's to read too.
    const keyMade = await keyMadePersona(base, owner)
    const personas = await client.callTool({ name: 'persona_list', arguments: {} })
    expect(personas.isError, JSON.stringify(personas)).toBeFalsy()
    expect(JSON.stringify(personas.structuredContent)).toContain(keyMade)
    const topics = await client.callTool({ name: 'topic_list', arguments: { limit: 5 } })
    expect(JSON.stringify(topics.structuredContent)).toContain('"personal":true')
    const conversations = await client.callTool({ name: 'inspect_conversations', arguments: {} })
    expect(conversations.isError, JSON.stringify(conversations)).toBeFalsy()
    expect(Schema.is(InspectConversations)(conversations.structuredContent)).toBe(true)
    const missing = await client.callTool({ name: 'inspect_turn', arguments: { operation: 'no-such-turn' } })
    expect(missing.isError).toBe(true)
    // The refusal quotes the request's reference, as it does over HTTP.
    const [refusal] = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(missing.content)
    expect(JSON.parse(refusal?.text ?? '{}')).toMatchObject({ _tag: 'NotFound', what: 'turn', ref: expect.any(String) })
  } finally {
    await client.close()
  }

  // Narrowed to Topics it lists, none yet: Personal is refused with a link to widen it, which its person follows.
  await grantOf(base, owner, clientId, { level: 'write', topics: [] })
  const refreshed = await token(base, owner, {
    grant_type: 'refresh_token',
    refresh_token: reading.refresh ?? '',
    client_id: clientId,
    resource: RESOURCE,
  })
  const narrowed = await connect(base, refreshed.access_token)
  try {
    expect(inspection((await narrowed.listTools()).tools.map((tool) => tool.name))).toEqual([])
    const outside = await narrowed.callTool({ name: 'topic_get', arguments: { id: 1 } })
    expect(outside.isError).toBe(true)
    const [text] = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(outside.content)
    const { widenUrl } = Schema.decodeUnknownSync(Refused)(JSON.parse(text?.text ?? '{}'))
    const link = new URL(widenUrl)
    expect([link.origin, link.pathname, link.searchParams.get('grant')]).toEqual([APP, '/consent/widen', grantId])
    expect(link.searchParams.get('reach')).toBe(`${owner.workspace}/topic/1`)
    // The widening page reads the grant's terms, and its approval lists Personal.
    const page = await fetch(`${base}/api/grants/${grantId}/terms`, { headers: browserOf(owner) })
    expect(page.status, await page.clone().text()).toBe(200)
    const widened = await fetch(`${base}/api/grants/${grantId}`, {
      method: 'PUT',
      headers: browserOf(owner),
      body: JSON.stringify({ grantId, terms: termsOf(owner, { level: 'write', topics: ['1'] }) }),
    })
    expect(widened.status, await widened.clone().text()).toBe(200)
    const inside = await narrowed.callTool({ name: 'topic_get', arguments: { id: 1 } })
    expect(inside.isError, JSON.stringify(inside)).toBeFalsy()
  } finally {
    await narrowed.close()
  }

  // Revoking the client in Settings ends every token.
  const revoked = await fetch(`${base}/api/clients/${clientId}`, { method: 'DELETE', headers: browserOf(owner) })
  expect(revoked.status).toBe(200)
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshed.access_token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(after.status).toBe(401)
}

/**
 * A server's key over HTTP (ADR 0114): a call its grant does not cover answers `access_insufficient` with a widening
 * link; its workspace's owner approves there, and the same key then passes.
 */
export async function keyWideningCase(base: string) {
  const owner = await person(base)
  const { key, secret } = await ownerKey(base, owner, 'read')
  const turns = () => fetch(`${base}/api/inspect/turns`, { headers: { authorization: `Bearer ${secret}` } })
  const refused = await turns()
  expect(refused.status).toBe(403)
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.Struct({ code: Schema.String, widenUrl: Schema.String }) }),
  )(await refused.json())
  expect(body.error.code).toBe('access_insufficient')
  const link = new URL(body.error.widenUrl)
  expect([link.pathname, link.searchParams.get('grant'), link.searchParams.get('extra')]).toEqual([
    '/consent/widen',
    key.id,
    'inspect',
  ])
  const widened = await fetch(`${base}/api/grants/${key.id}`, {
    method: 'PUT',
    headers: browserOf(owner),
    body: JSON.stringify({
      grantId: key.id,
      terms: keyBody(owner, 'ignored', { level: 'read', extras: ['inspect'] }).terms,
    }),
  })
  expect(widened.status, await widened.clone().text()).toBe(200)
  expect((await turns()).status).toBe(200)
  // Another person may not approve it: the grant is not there for them.
  const stranger = await person(base)
  const theirs = await fetch(`${base}/api/grants/${key.id}/terms`, { headers: browserOf(stranger) })
  expect(theirs.status).toBe(404)
}

/** A tool call's structured answer, or its error result's text. */
const answerOf = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args })
  return result.isError === true ? { error: JSON.stringify(result.content) } : result.structuredContent
}

/**
 * One /mcp for several workspaces (ADRs 0097, 0114): a client whose grant names two of the person's reaches each by the
 * workspace a call names, and nothing else; given all, it reaches one made after it signed in; revoked, nothing.
 */
export async function reachCase(base: string) {
  const owner = await person(base)
  const madeAt = async (name: string) => {
    const made = await call(base, owner, '/api/workspaces', {
      name,
      slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`,
    })
    expect(made.status).toBe(201)
    return Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, slug: Schema.String }))(await made.json())
  }
  const team = await madeAt('Team')
  const clientId = await register(base, owner)
  const granted = await authorize(base, owner, clientId, {
    scope: ALL_SCOPES,
    terms: { level: 'write', workspaces: [owner.workspace, team.id] },
  })
  const client = await connect(base, granted.access)
  try {
    const listed = await answerOf(client, 'workspace_list', {})
    expect(JSON.stringify(listed)).toContain(team.slug)
    expect(JSON.stringify(listed)).toContain(owner.slug)
    const name = `Team only ${crypto.randomUUID().slice(0, 6)}`
    await answerOf(client, 'topic_create', { workspace: team.slug, name, operationId: crypto.randomUUID() })
    expect(JSON.stringify(await answerOf(client, 'topic_list', { workspace: team.id }))).toContain(name)
    expect(JSON.stringify(await answerOf(client, 'topic_list', { workspace: owner.slug }))).not.toContain(name)
    // Several reached, so a call names its workspace (its schema requires it); one it does not reach is not there.
    expect(JSON.stringify(await answerOf(client, 'topic_list', {}))).toContain('workspace: Missing key')
    expect(JSON.stringify(await answerOf(client, 'topic_list', { workspace: 'elsewhere' }))).toContain('NotFound')
  } finally {
    await client.close()
  }
  // All of the person's workspaces, a later one included, without signing in again.
  await grantOf(base, owner, clientId, { level: 'write', workspaces: 'all' })
  const later = await madeAt('Later')
  const again = await connect(base, granted.access)
  try {
    expect(JSON.stringify(await answerOf(again, 'workspace_list', {}))).toContain(later.slug)
  } finally {
    await again.close()
  }
  const revoked = await fetch(`${base}/api/clients/${clientId}`, {
    method: 'DELETE',
    headers: { cookie: owner.cookie, origin: APP, 'x-goblin-csrf': '1', 'cf-connecting-ip': owner.ip },
  })
  expect(revoked.status).toBe(200)
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${granted.access}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(after.status).toBe(401)
}
