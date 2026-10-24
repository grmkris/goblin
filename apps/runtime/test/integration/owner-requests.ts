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

/**
 * A new key's body as Settings sends it (ADR 0114): its name and its grant's terms over `who`'s workspace, `manage`
 * unless `terms` say, for a day. `lists` makes its Topics and Personas lists, growing with what it makes, so it reaches
 * nothing of anyone else's; `connections` lists the connections its setups may name.
 */
export const keyBody = (
  who: Person,
  name: string,
  terms: {
    readonly level?: 'read' | 'write' | 'manage'
    readonly extras?: readonly ('setup' | 'routines' | 'inspect')[]
    readonly lists?: boolean
    readonly connections?: readonly string[]
    readonly origins?: readonly { readonly origin: string; readonly tools: readonly string[] }[]
  } = {},
) => {
  const list = terms.lists === true ? { kind: 'list', ids: [] } : { kind: 'all' }
  return {
    name,
    terms: {
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
    },
  }
}

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
