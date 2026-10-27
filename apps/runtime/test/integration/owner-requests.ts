import type { WorkspaceSnapshot } from '@goblin/contracts'
import { expect } from 'vitest'
import { Schema } from 'effect'
import { type AgentFetch, workspaceSnapshot } from '../owner-client.ts'
import { ownerSnapshot } from './probe-reads.ts'
import { waitFor } from './until.ts'

const Signup = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
const Workspaces = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }))
export interface Person {
  readonly userId: string
  readonly cookie: string
  readonly ip: string
  readonly email: string
  /** The workspace the person was given at their first sign-in (ADR 0089): its ID, which names its agent. */
  readonly workspace: string
  /** That workspace's slug, under which their browser's requests go. */
  readonly slug: string
}

/** The paths a person's browser sends as they are; every other `/api/` path is a member's, under their workspace. */
const PERSON_PATHS = [
  '/api/auth/',
  '/api/workspaces',
  '/api/invitations',
  '/api/clients',
  '/api/grants',
  '/api/install/',
  '/api/client-errors',
]

/** `path` as `who`'s browser sends it: a member's `/api/…` path under `/w/<their workspace's slug>` (ADR 0089). */
export const inWorkspace = (who: Person, path: string): string =>
  path.startsWith('/api/') && !PERSON_PATHS.some((prefix) => path.startsWith(prefix)) ? `/w/${who.slug}${path}` : path

/** The owner stack's app (`APP_URL`): the web's requests come from its origin. */
const APP = 'https://goblin.test'

/** Workerd can close a retained HTTP socket; each fixture request gets its own connection. */
export const ownerFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}
export async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const email = `${crypto.randomUUID()}@fixture.test`
  const headers = { origin: APP, 'content-type': 'application/json', 'cf-connecting-ip': ip }
  const sent = await ownerFetch(`${base}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  expect(sent.status).toBe(200)
  const mail = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
    await (await ownerFetch(`${base}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
  const response = await ownerFetch(`${base}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, otp: mail.code }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const listed = await ownerFetch(`${base}/api/workspaces`, {
    headers: { cookie, origin: APP, 'cf-connecting-ip': ip },
  })
  expect(listed.status).toBe(200)
  const [workspace] = Schema.decodeUnknownSync(Workspaces)(await listed.json())
  if (workspace === undefined) throw new Error('no first workspace')
  return {
    userId: Schema.decodeUnknownSync(Signup)(await response.json()).user.id,
    ip,
    email,
    cookie,
    workspace: workspace.id,
    slug: workspace.slug,
  }
}

/** What `who`'s browser sends with every request: their session cookie, the app's origin, the CSRF header and their address. */
const browserHeaders = (who: Person) => ({
  cookie: who.cookie,
  origin: APP,
  'content-type': 'application/json',
  'x-goblin-csrf': '1',
  'cf-connecting-ip': who.ip,
})

/**
 * One request of `who`'s browser to `path` on the Worker at `base`, a member's `/api/…` path under their workspace
 * (`inWorkspace`): a GET, or a POST of `body` as JSON. For what the typed client cannot say (an edge refusal's status,
 * the auth routes, the test levers).
 */
export const call = (base: string, who: Person, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  ownerFetch(`${base}${inWorkspace(who, path)}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...browserHeaders(who), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** What a test server's grant holds (ADR 0114), as `scriptApp` takes it. */
export interface ServerTerms {
  readonly level?: 'read' | 'write' | 'manage'
  readonly extras?: readonly ('setup' | 'routines' | 'inspect')[]
  readonly lists?: boolean
  readonly connections?: readonly string[]
  readonly origins?: readonly { readonly origin: string; readonly tools: readonly string[] }[]
}

/**
 * A grant's terms over `who`'s workspace for a server named `name` (ADR 0114), `manage` unless `terms` say, for a day.
 * `lists` makes its Topics and Personas lists, growing with what it makes, so it reaches nothing of anyone else's;
 * `connections` lists the connections its setups may name.
 */
export const serverTerms = (who: Person, name: string, terms: ServerTerms = {}) => {
  const list = terms.lists === true ? { kind: 'list', ids: [] } : { kind: 'all' }
  return {
    name,
    level: terms.level ?? 'manage',
    extras: terms.extras ?? [],
    lifetime: '1d',
    reach: {
      workspaces: 'list',
      each: [
        {
          workspace: who.workspace,
          topics: list,
          personas: list,
          connections:
            terms.connections === undefined ? { kind: 'all' } : { kind: 'list', ids: [...terms.connections] },
        },
      ],
      origins: terms.origins ?? [],
    },
  }
}

/** A server as a test drives it (ADRs 0118, 0120): a script app installed in `who`'s workspace, and its token. */
export interface Server {
  readonly name: string
  readonly clientId: string
  readonly secret: string
  /** Its installation, whose id is its grant's: what a widening link names. */
  readonly installationId: string
  readonly token: string
  /** The workspace it is installed in, by slug: where its requests go. */
  readonly slug: string
}

const Registered = Schema.Struct({
  app: Schema.Struct({ clientId: Schema.String }),
  clientSecret: Schema.String,
  installation: Schema.Struct({ id: Schema.String }),
})
const Token = Schema.Struct({ access_token: Schema.String })

/** An app's token request (ADR 0118): client_credentials with its secret as HTTP Basic, for goblin's /mcp resource. */
export const tokenRequest = (base: string, clientId: string, secret: string) =>
  ownerFetch(`${base}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource: `${APP}/mcp`, scope: 'goblin' }).toString(),
  })

/** An app's access token, which the token endpoint must give (`tokenRequest`). */
export async function appToken(base: string, clientId: string, secret: string): Promise<string> {
  const answered = await tokenRequest(base, clientId, secret)
  expect(answered.status, await answered.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(Token)(await answered.json()).access_token
}

/**
 * A script app `who` registers and installs in their workspace in one step (ADR 0118), named `name` with `terms` as
 * its grant, and its token: how a server or a script calls goblin since keys are gone (ADR 0125).
 */
export async function scriptApp(base: string, who: Person, name: string, terms: ServerTerms = {}): Promise<Server> {
  const made = await call(base, who, '/api/developer/apps', {
    name,
    returnUrls: [],
    script: true,
    terms: serverTerms(who, name, terms),
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const { app, clientSecret, installation } = Schema.decodeUnknownSync(Registered)(await made.json())
  const token = await appToken(base, app.clientId, clientSecret)
  return { name, clientId: app.clientId, secret: clientSecret, installationId: installation.id, token, slug: who.slug }
}

/**
 * One request of `server` (`path` an owner API path, `/api/…`): its token as the bearer under its workspace's path, no
 * cookie, no Origin, a JSON body when there is one.
 */
export const asServer = (base: string, server: Server, method: string, path: string, body?: unknown) =>
  ownerFetch(`${base}/w/${server.slug}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/**
 * The owner API as `who`'s browser reaches it: through the Worker at `base`, under their workspace, with what `call`
 * sends, and `headers` on top. It stands where an agent's `fetch` does, so the typed client (`callOwner`,
 * `ownerResult`) and the reads of `probe-reads.ts` take it.
 */
export const signedIn = (base: string, who: Person, headers: Record<string, string> = {}): AgentFetch => ({
  fetch: async (request) => {
    const { pathname, search } = new URL(request.url)
    const sent = new Headers(request.headers)
    for (const [name, value] of Object.entries({ ...browserHeaders(who), ...headers })) sent.set(name, value)
    const body = request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }
    return ownerFetch(`${base}${inWorkspace(who, pathname)}${search}`, {
      method: request.method,
      headers: sent,
      ...body,
    })
  },
})

/** A test lever of the owner stack's Worker (`/__test/<name>`), as `who`: a GET, or a POST of `body`. */
export const lever = (base: string, who: Person, name: string, body?: unknown) =>
  call(base, who, `/__test/${name}`, body)

/** The inputs the queue model holds now, as its lever's text. */
const heldText = async (base: string, who: Person) => (await lever(base, who, 'queue/held')).text()

/** How long the owner cases wait for a turn to reach a state: the queue model, the snapshot, the workspace. */
const SETTLE_MS = 10_000

/** Until the queue model holds `input`. */
export const holding = (base: string, who: Person, input: string) =>
  waitFor(
    () => heldText(base, who),
    (held) => held.includes(input),
    `${input} held`,
    SETTLE_MS,
  )

/** Until the queue model no longer holds `input`: its run ended (Stop aborts a held generation). */
export const released = (base: string, who: Person, input: string) =>
  waitFor(
    () => heldText(base, who),
    (held) => !held.includes(input),
    `${input} released`,
    SETTLE_MS,
  )

/** `chat`'s Pi snapshot as JSON text, through the typed client. */
export const snapshotText = async (agent: AgentFetch, chat: string) => JSON.stringify(await ownerSnapshot(agent, chat))

/** Until `chat`'s snapshot holds `expected`; its text then. */
export const showing = (agent: AgentFetch, chat: string, expected: string) =>
  waitFor(
    () => snapshotText(agent, chat),
    (text) => text.includes(expected),
    `${expected} in chat ${chat}`,
    SETTLE_MS,
  )

/** The workspace feed's snapshot as `who` sees it (`GET /api/workspace/events`, or `path` with `headers`). */
export const workspaceOf = async (
  base: string,
  who: Person,
  path = '/api/workspace/events',
  headers: Record<string, string> = {},
): Promise<WorkspaceSnapshot> => workspaceSnapshot(await call(base, who, path, undefined, headers))

/** The workspace feed's snapshot once `done` holds for it. */
export const workspaceUntil = (base: string, who: Person, done: (snapshot: WorkspaceSnapshot) => boolean) =>
  waitFor(() => workspaceOf(base, who), done, 'the workspace state', SETTLE_MS)
