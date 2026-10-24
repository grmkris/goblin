import { TopicView } from '@goblin/contracts'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { answerOf, connect } from './auth-inspect.ts'
import { signIn } from './members-case.ts'
import { type Person, call, ownerFetch, person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const RESOURCE = `${APP}/mcp`
const RETURN = 'https://product.test/goblin/installed'

/** A grant's terms over `workspace` as the editor writes them: `level`, everything, no extras, until removed. */
const terms = (workspace: string, level: 'read' | 'write' | 'manage' = 'write') => ({
  name: 'Product',
  level,
  extras: [],
  lifetime: 'never',
  reach: {
    workspaces: 'list',
    each: [{ workspace, topics: { kind: 'all' }, personas: { kind: 'all' }, connections: { kind: 'all' } }],
    origins: [],
  },
})

const Registered = Schema.Struct({
  app: Schema.Struct({ clientId: Schema.String }),
  clientSecret: Schema.String,
  installation: Schema.optional(Schema.Struct({ id: Schema.String })),
})
const Answer = Schema.Struct({
  installation: Schema.Struct({ id: Schema.String }),
  redirect: Schema.optional(Schema.String),
})
const Token = Schema.Struct({ access_token: Schema.String })
const Slugged = Schema.Struct({ id: Schema.String, slug: Schema.String })
const Sent = Schema.Array(Schema.Struct({ invitation: Schema.Struct({ id: Schema.String }) }))

/** An app's token request (client_credentials, its secret as HTTP Basic), for goblin's /mcp resource. */
const tokenRequest = (base: string, clientId: string, secret: string) =>
  ownerFetch(`${base}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource: RESOURCE, scope: 'goblin' }).toString(),
  })

/** An app's access token, which the token endpoint must give. */
const tokenOf = async (base: string, clientId: string, secret: string): Promise<string> => {
  const answered = await tokenRequest(base, clientId, secret)
  expect(answered.status, await answered.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(Token)(await answered.json()).access_token
}

/** One request of an app's backend: its token as the bearer, no cookie, no CSRF header. */
const asApp = (base: string, token: string, path: string, body?: unknown, method?: string) =>
  ownerFetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** `who`'s browser changing something with `method` (PATCH, DELETE): `call` sends only GET and POST. */
const send = (base: string, who: Person, method: string, path: string, body?: unknown) =>
  ownerFetch(`${base}/w/${who.slug}${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      origin: APP,
      'x-goblin-csrf': '1',
      'content-type': 'application/json',
      'cf-connecting-ip': who.ip,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** App `name` registered by `owner`'s workspace with a return address: its client id and secret. */
async function register(base: string, owner: Person, name: string) {
  const made = await call(base, owner, '/api/developer/apps', {
    name,
    homepage: 'https://product.test',
    returnUrls: [RETURN],
    terms: terms(owner.workspace),
  })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Registered)(await made.json())
}

/** `who` invited into `owner`'s workspace as `role`, signed in and joined. */
async function joined(base: string, owner: Person, role: 'admin' | 'member'): Promise<Person> {
  const email = `${crypto.randomUUID()}@fixture.test`
  const invited = await call(base, owner, '/api/members/invitations', { emails: [email], role })
  expect(invited.status).toBe(201)
  const [sent] = Schema.decodeUnknownSync(Sent)(await invited.json())
  const { who } = await signIn(base, email)
  if (who === undefined) throw new Error('the invited address could not sign in')
  expect((await call(base, who, `/api/invitations/${sent?.invitation.id ?? ''}/accept`, {})).status).toBe(200)
  return { ...who, workspace: owner.workspace, slug: owner.slug }
}

/**
 * Apps and installations (ADR 0118) through the real Worker, agent and auth D1: a workspace registers an app, an owner
 * installs it from the install page and is sent back to the app's address, and the app's client_credentials token then
 * reaches that workspace's owner API, a chat's stream, its Events and /mcp, and nothing else. Narrowing its grant
 * applies at once; a member cannot install; an admin's installation outlives them; rotating the secret ends the old one;
 * a script app installs itself; uninstalling and deleting end it.
 */
export async function installsCase(base: string): Promise<void> {
  const owner = await person(base)
  const { app, clientSecret } = await register(base, owner, 'Product')
  // Registered, installed nowhere: its token reaches no workspace.
  const early = await tokenOf(base, app.clientId, clientSecret)
  expect((await asApp(base, early, `/w/${owner.slug}/api/topics`)).status).toBe(404)

  const info = await call(base, owner, `/api/install/${app.clientId}`)
  expect(info.status, await info.clone().text()).toBe(200)
  expect(await info.json()).toMatchObject({
    name: 'Product',
    script: false,
    workspaces: [{ id: owner.workspace, slug: owner.slug, role: 'owner', installed: false }],
  })
  const approved = await call(base, owner, `/api/install/${app.clientId}`, {
    workspace: owner.workspace,
    terms: terms(owner.workspace),
    state: 'opaque-1',
  })
  expect(approved.status, await approved.clone().text()).toBe(200)
  const { installation, redirect } = Schema.decodeUnknownSync(Answer)(await approved.json())
  const back = new URL(redirect ?? '')
  expect([
    `${back.origin}${back.pathname}`,
    ...['installation', 'workspace', 'state'].map((name) => back.searchParams.get(name)),
  ]).toEqual([RETURN, installation.id, owner.slug, 'opaque-1'])

  // Its token on the workspace's path: the owner API with no CSRF header, a chat's stream and the Events methods.
  const token = await tokenOf(base, app.clientId, clientSecret)
  const made = await asApp(base, token, `/w/${owner.slug}/api/topics`, {
    name: 'Product topic',
    operationId: 'product:1',
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const topic = Schema.decodeUnknownSync(TopicView)(await made.json())
  const stream = await asApp(base, token, `/w/${owner.slug}/api/conversations/${topic.conversation}/stream`)
  expect(stream.status).toBe(200)
  expect(stream.headers.get('content-type')).toContain('text/event-stream')
  await stream.body?.cancel()
  expect((await asApp(base, token, `/w/${owner.slug}/api/events`)).status).toBe(200)
  // And /mcp, where it reaches the workspaces it is installed in.
  const client = await connect(base, token)
  try {
    expect(JSON.stringify(await answerOf(client, 'workspace_list', {}))).toContain(owner.slug)
  } finally {
    await client.close()
  }

  // Nothing else: another workspace, the people's paths, a cookie beside it.
  const other = await call(base, owner, '/api/workspaces', {
    name: 'Elsewhere',
    slug: `elsewhere-${crypto.randomUUID().slice(0, 6)}`,
  })
  const elsewhere = Schema.decodeUnknownSync(Slugged)(await other.json())
  expect((await asApp(base, token, `/w/${elsewhere.slug}/api/topics`)).status).toBe(404)
  expect((await asApp(base, token, `/w/${owner.slug}/api/members`)).status).toBe(403)
  expect((await asApp(base, token, '/api/workspaces')).status).toBe(401)

  // Its grant, as Installed apps lists it, narrowed to read: a write is refused at once, with the widening link.
  const listed = await call(base, owner, '/api/installations')
  expect(await listed.json()).toMatchObject([
    { id: installation.id, clientId: app.clientId, terms: { level: 'write' } },
  ])
  expect(
    (
      await send(base, owner, 'PATCH', `/api/installations/${installation.id}`, {
        terms: terms(owner.workspace, 'read'),
      })
    ).status,
  ).toBe(200)
  const refused = await asApp(base, token, `/w/${owner.slug}/api/topics`, { name: 'Refused', operationId: 'product:2' })
  expect(refused.status).toBe(403)
  expect(await refused.text()).toContain(`/consent/widen?grant=${installation.id}`)

  // A member may not install; an admin may, and the installation outlives their leaving.
  const member = await joined(base, owner, 'member')
  const second = await register(base, owner, 'Second')
  const byMember = await call(base, member, `/api/install/${second.app.clientId}`, {
    workspace: owner.workspace,
    terms: terms(owner.workspace),
  })
  expect(byMember.status).toBe(403)
  const admin = await joined(base, owner, 'admin')
  const byAdmin = await call(base, admin, `/api/install/${second.app.clientId}`, {
    workspace: owner.workspace,
    terms: terms(owner.workspace),
  })
  expect(byAdmin.status, await byAdmin.clone().text()).toBe(200)
  expect((await call(base, admin, '/api/members/leave', {})).status).toBe(200)
  const secondToken = await tokenOf(base, second.app.clientId, second.clientSecret)
  expect((await asApp(base, secondToken, `/w/${owner.slug}/api/topics`)).status).toBe(200)

  // A rotated secret ends the old one.
  const rotated = await call(base, owner, `/api/developer/apps/${app.clientId}/rotate`, {})
  expect(rotated.status).toBe(200)
  const { clientSecret: renewed } = Schema.decodeUnknownSync(Schema.Struct({ clientSecret: Schema.String }))(
    await rotated.json(),
  )
  expect((await tokenRequest(base, app.clientId, clientSecret)).status).toBe(401)
  await tokenOf(base, app.clientId, renewed)

  // A script app: no return address, installed here as it is registered.
  const script = await call(base, owner, '/api/developer/apps', {
    name: 'Script',
    returnUrls: [],
    script: true,
    terms: terms(owner.workspace),
  })
  expect(script.status, await script.clone().text()).toBe(201)
  const scripted = Schema.decodeUnknownSync(Registered)(await script.json())
  expect(scripted.installation).toBeDefined()
  const scriptToken = await tokenOf(base, scripted.app.clientId, scripted.clientSecret)
  expect((await asApp(base, scriptToken, `/w/${owner.slug}/api/topics`)).status).toBe(200)

  // Uninstalled, its token reaches nothing; deleted, it gets no token at all.
  expect((await send(base, owner, 'DELETE', `/api/installations/${installation.id}`)).status).toBe(200)
  expect((await asApp(base, token, `/w/${owner.slug}/api/topics`)).status).toBe(404)
  expect((await send(base, owner, 'DELETE', `/api/developer/apps/${app.clientId}`)).status).toBe(200)
  expect((await tokenRequest(base, app.clientId, renewed)).status).toBe(401)
}
