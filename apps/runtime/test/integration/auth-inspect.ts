import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { TopicView } from '@goblin/contracts'
import { InspectConversations } from '@goblin/contracts/inspect'
import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { joinedMember } from './members-case.ts'
import { type Person, asServer, call, person, scriptApp, serverTerms } from './owner-requests.ts'

export const APP = 'https://goblin.test'
export const REDIRECT = 'http://127.0.0.1:9/callback'
export const RESOURCE = `${APP}/mcp`
const SIGN_IN_SCOPES = 'openid profile email offline_access'
/** What a client asks for since ADR 0114: the sign-in scopes and `goblin`; what it may do is its grant. */
export const ALL_SCOPES = `${SIGN_IN_SCOPES} goblin`
const Registered = Schema.Struct({ client_id: Schema.String })
const Tokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optional(Schema.String),
})
const Redirect = Schema.Struct({ url: Schema.optional(Schema.String), redirect_uri: Schema.optional(Schema.String) })

type Grant = {
  readonly access: string
  readonly tokenType: string
  readonly refresh: string | undefined
  readonly asked: boolean
  /** The scope the consent page was asked to show, when it was. */
  readonly askedScope: string | undefined
}

type AuthInit = { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string }
export const auth = (base: string, who: Person, path: string, init: AuthInit = {}) =>
  fetch(`${base}/api/auth${path}`, {
    redirect: 'manual',
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: { cookie: who.cookie, origin: APP, 'cf-connecting-ip': who.ip, ...init.headers },
  })

/** Where an authorize or consent step sends the browser: a redirect, or the provider's JSON `{ url }`. */
export async function next(response: Response): Promise<URL> {
  const location = response.headers.get('location')
  if (location !== null) return new URL(location, APP)
  const body = Schema.decodeUnknownSync(Redirect)(await response.json())
  return new URL(body.url ?? body.redirect_uri ?? '', APP)
}

/** Dynamic registration as Claude Code makes it: no scope, so the client may ask for every /mcp scope. */
export async function register(base: string, who: Person): Promise<string> {
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

export const browserOf = (who: Person) => ({
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
export async function grantOf(base: string, who: Person, clientId: string, terms: Terms): Promise<string> {
  const set = await fetch(`${base}/api/clients/${encodeURIComponent(clientId)}/grant`, {
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
  /** The redirect this authorization uses, the registered one unless said: loopback ports vary (ADR 0122). */
  readonly redirect?: string
  /** More authorization parameters, as a client sends them. */
  readonly query?: Record<string, string>
  /** More headers on the token request, as a client sends them. */
  readonly tokenHeaders?: Record<string, string>
}

/** One sign-in of a registered client to /mcp: authorize, the consent page when the owner must answer, token. */
export async function authorize(base: string, who: Person, clientId: string, request: Authorization): Promise<Grant> {
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const redirect = request.redirect ?? REDIRECT
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: request.scope,
    resource: RESOURCE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'fixture',
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...request.query,
  })
  let landing = await next(
    await auth(base, who, `/oauth2/authorize?${query.toString()}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }),
  )
  const asked = landing.pathname === '/consent'
  const askedScope = asked ? (landing.searchParams.get('scope') ?? undefined) : undefined
  if (asked) {
    // What the consent page reads to say what the client asks for: at least what it asked (`offline_access` is added).
    expect(askedScope?.split(' ')).toEqual(expect.arrayContaining(request.scope.split(' ')))
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
  expect(landing.origin + landing.pathname).toBe(redirect)
  const tokens = await token(
    base,
    who,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    },
    request.tokenHeaders,
  )
  return { access: tokens.access_token, tokenType: tokens.token_type, refresh: tokens.refresh_token, asked, askedScope }
}

export async function token(
  base: string,
  who: Person,
  form: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const response = await auth(base, who, '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(Tokens)(await response.json())
}

/** An MCP client of /mcp with a bearer token, through the real Worker. */
export async function connect(base: string, access: string) {
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

/** A Persona one of the owner's own installed apps made (ADR 0118), by its name. */
async function appMadePersona(base: string, who: Person): Promise<string> {
  const server = await scriptApp(base, who, 'service-manage', { level: 'manage' })
  const persona = await asServer(base, server, 'POST', '/api/personas', {
    name: 'Appmade',
    avatar: { glyph: 'A', hue: 10 },
    role: 'Made by an app',
    instructions: 'Be brief.',
    operationId: 'service:persona:1',
  })
  expect(persona.status, await persona.clone().text()).toBe(201)
  return 'Appmade'
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

/** One resource: every metadata path names /mcp and offers `goblin` alone; the 401 asks for it (ADR 0122). */
async function discoveryCase(base: string) {
  for (const path of ['', '/mcp', '/mcp/inspect'])
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource${path}`)).json(), path).toMatchObject({
      resource: RESOURCE,
      scopes_supported: ['goblin'],
    })
  const challenge = await fetch(`${base}/mcp`, { method: 'POST' })
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="goblin"`,
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
  expect(readTools).not.toContain('conversation_send')
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
    // Every Persona of the workspace: one of the owner's apps made is the client's to read too.
    const appMade = await appMadePersona(base, owner)
    const personas = await client.callTool({ name: 'persona_list', arguments: {} })
    expect(personas.isError, JSON.stringify(personas)).toBeFalsy()
    expect(JSON.stringify(personas.structuredContent)).toContain(appMade)
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
 * An installed app over HTTP (ADRs 0114, 0118): a call its grant does not cover answers `access_insufficient` with a
 * widening link to its installation's grant; its workspace's owner approves there, and the same token then passes.
 */
export async function appWideningCase(base: string) {
  const owner = await person(base)
  const server = await scriptApp(base, owner, 'service-read', { level: 'read' })
  const turns = () => asServer(base, server, 'GET', '/api/inspect/turns')
  const refused = await turns()
  expect(refused.status).toBe(403)
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.Struct({ code: Schema.String, widenUrl: Schema.String }) }),
  )(await refused.json())
  expect(body.error.code).toBe('access_insufficient')
  const link = new URL(body.error.widenUrl)
  expect([link.pathname, link.searchParams.get('grant'), link.searchParams.get('extra')]).toEqual([
    '/consent/widen',
    server.installationId,
    'inspect',
  ])
  const widened = await fetch(`${base}/api/grants/${server.installationId}`, {
    method: 'PUT',
    headers: browserOf(owner),
    body: JSON.stringify({
      grantId: server.installationId,
      terms: serverTerms(owner, 'service-read', { level: 'read', extras: ['inspect'] }),
    }),
  })
  expect(widened.status, await widened.clone().text()).toBe(200)
  expect((await turns()).status).toBe(200)
  // Another person may not approve it: the grant is not there for them.
  const stranger = await person(base)
  const theirs = await fetch(`${base}/api/grants/${server.installationId}/terms`, { headers: browserOf(stranger) })
  expect(theirs.status).toBe(404)
}

/** A tool call's structured answer, or its error result's text. */
export const answerOf = async (client: Client, name: string, args: Record<string, unknown>) => {
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

/** The first frame of a chat's stream that holds `type`, read from `response`'s body; the body is cancelled after. */
async function frameOf(response: Response, type: string): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('a stream without a body')
  const decoder = new TextDecoder()
  let read = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`the stream ended before ${type}`)
      read += decoder.decode(value, { stream: true })
      const frame = read.split('\n').find((line) => line.startsWith('data: ') && line.includes(`"${type}"`))
      if (frame !== undefined) return frame
    }
  } finally {
    await reader.cancel()
  }
}

/**
 * An OAuth client's token on its workspace's path (ADR 0116), through the real Worker and agent: it reads and makes
 * Topics with no CSRF header and follows a chat's stream, as the person it acts for; a workspace its grant does not
 * reach is not there, the people's paths refuse it, and revoking the client ends it.
 */
export async function restBearerCase(base: string) {
  const owner = await person(base)
  const made = await call(base, owner, '/api/workspaces', {
    name: 'Elsewhere',
    slug: `elsewhere-${crypto.randomUUID().slice(0, 6)}`,
  })
  expect(made.status).toBe(201)
  const elsewhere = Schema.decodeUnknownSync(Schema.Struct({ slug: Schema.String }))(await made.json())
  const clientId = await register(base, owner)
  const granted = await authorize(base, owner, clientId, {
    scope: ALL_SCOPES,
    terms: { level: 'write', workspaces: [owner.workspace] },
  })
  const bearer = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${granted.access}`, 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  const name = `Bearer ${crypto.randomUUID().slice(0, 6)}`
  const created = await bearer(`/w/${owner.slug}/api/topics`, {
    method: 'POST',
    body: { name, operationId: `bearer:${name}` },
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const topic = Schema.decodeUnknownSync(TopicView)(await created.json())
  const listed = await bearer(`/w/${owner.slug}/api/topics`)
  expect(listed.status).toBe(200)
  expect(await listed.text()).toContain(name)
  const stream = await bearer(`/w/${owner.slug}/api/conversations/${topic.conversation}/stream`, {
    headers: { accept: 'text/event-stream' },
  })
  expect(stream.status, stream.status === 200 ? '' : await stream.clone().text()).toBe(200)
  expect(stream.headers.get('content-type')).toContain('text/event-stream')
  expect(await frameOf(stream, 'MESSAGES_SNAPSHOT')).toContain('"messages"')
  // Outside its reach, on the people's paths, and with a session beside it, the token reaches nothing.
  expect((await bearer(`/w/${elsewhere.slug}/api/topics`)).status).toBe(404)
  expect((await bearer(`/w/${owner.slug}/api/members`)).status).toBe(403)
  expect((await bearer('/api/workspaces')).status).toBe(401)
  expect((await bearer(`/w/${owner.slug}/api/topics`, { headers: { cookie: owner.cookie } })).status).toBe(403)
  const revoked = await fetch(`${base}/api/clients/${clientId}`, {
    method: 'DELETE',
    headers: { cookie: owner.cookie, origin: APP, 'x-goblin-csrf': '1', 'cf-connecting-ip': owner.ip },
  })
  expect(revoked.status).toBe(200)
  expect((await bearer(`/w/${owner.slug}/api/topics`)).status).toBe(401)
  // A server API key of before ADR 0120 is a bearer like any other: nothing on bare /api, the sign-in challenge on
  // /mcp.
  const oldKey = `gbk_${'k'.repeat(64)}`
  expect((await fetch(`${base}/api/topics`, { headers: { authorization: `Bearer ${oldKey}` } })).status).toBe(404)
  const challenged = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${oldKey}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(challenged.status).toBe(401)
  expect(challenged.headers.get('www-authenticate')).toContain('resource_metadata')
}

/** The tools of a workspace's connections themselves (ADR 0117), sorted. */
const CONNECTIONS = [
  'server_add',
  'server_connect',
  'server_disconnect',
  'server_remove',
  'server_rename',
  'server_skills_set',
  'tool_grant_set',
  'tool_grants_list',
  'tool_grants_set',
]
const ServerAdded = Schema.Struct({ connectionId: Schema.String, label: Schema.String, status: Schema.String })

/**
 * The setup extra over a workspace's connections (ADR 0117), through the real Worker and agent: an owner's client with
 * `manage` and `setup` adds a server over /mcp, starts its sign-in, grants its tools, turns its skills off and renames
 * and removes it; narrowed to `write`, the same REST call answers `access_insufficient` with the widening link; a
 * member's client is refused by the member's role, whatever its grant.
 */
export async function connectionSetupCase(base: string) {
  const owner = await person(base)
  const clientId = await register(base, owner)
  const granted = await authorize(base, owner, clientId, {
    scope: ALL_SCOPES,
    terms: { level: 'manage', extras: ['setup'] },
  })
  expect((await toolsOf(base, granted.access)).filter((name) => CONNECTIONS.includes(name)).toSorted()).toEqual(
    CONNECTIONS,
  )
  const client = await connect(base, granted.access)
  try {
    const added = Schema.decodeUnknownSync(ServerAdded)(
      await answerOf(client, 'server_add', { endpoint: 'https://second-fixture.test/mcp', label: 'Second' }),
    )
    expect(added).toMatchObject({ label: 'Second' })
    const id = added.connectionId
    expect(JSON.stringify(await answerOf(client, 'server_connect', { id }))).not.toContain('error')
    const set = await answerOf(client, 'tool_grants_set', { connectionId: id, names: ['board'], allowed: true })
    expect(JSON.stringify(set)).toContain('"name":"board"')
    // A list answers as its text alone (`tools.ts` `text`).
    const listed = await client.callTool({ name: 'tool_grants_list', arguments: {} })
    expect(JSON.stringify(listed.content)).toContain(id)
    expect(await answerOf(client, 'server_skills_set', { connectionId: id, enabled: false })).toEqual({
      connectionId: id,
      enabled: false,
    })
    expect(await answerOf(client, 'server_rename', { id, label: 'Renamed' })).toMatchObject({ label: 'Renamed' })
    await answerOf(client, 'server_remove', { id })
    const servers = await client.callTool({ name: 'server_list', arguments: {} })
    expect(servers.isError).not.toBe(true)
    expect(JSON.stringify(servers.content)).not.toContain(id)
  } finally {
    await client.close()
  }
  // Narrowed to write, the client is offered only the read of them, and a change over REST says what it lacks.
  await grantOf(base, owner, clientId, { level: 'write', extras: ['setup'] })
  expect((await toolsOf(base, granted.access)).filter((name) => CONNECTIONS.includes(name))).toEqual([
    'tool_grants_list',
  ])
  const addAs = (access: string, slug: string) =>
    fetch(`${base}/w/${slug}/api/mcp/servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://third-fixture.test/mcp' }),
    })
  const lacking = await addAs(granted.access, owner.slug)
  expect(lacking.status).toBe(403)
  expect(await lacking.json()).toMatchObject({ error: { code: 'access_insufficient' } })
  // An installed app with manage and setup configures its own workspace's connections too.
  const server = await scriptApp(base, owner, 'service-setup', { level: 'manage', extras: ['setup'] })
  const added = await asServer(base, server, 'POST', '/api/mcp/servers', { endpoint: 'https://app-fixture.test/mcp' })
  expect(added.status, await added.clone().text()).toBe(201)
  // A member's client never configures the workspace, even with a grant that holds it: the member's role refuses it.
  const member = await joinedMember(base, owner)
  const theirs = await authorize(base, member, await register(base, member), {
    scope: ALL_SCOPES,
    terms: { level: 'manage', extras: ['setup'] },
  })
  const refused = await addAs(theirs.access, owner.slug)
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
}
