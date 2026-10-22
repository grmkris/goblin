import { NotFound, Unauthenticated, envelopeOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { type AccountRecords, crashPoint } from '../../../src/http/api/account.ts'
import { type Edge, isAccountPath, isWorkspacePath, makeEdgeHttp } from '../../../src/http/api/edge.ts'
import { attempt } from '../../../src/http/errors.ts'
import { FlowPointFailure } from '../../../src/observability/ae.ts'
import { withLines } from '../../observability/lines.ts'
import { fake } from '../../fake.ts'

const APP = 'https://goblin.test'
const OWNER = 'user-owner'
/** The owner's workspace (ADR 0089): its ID, which names its agent, and its pages' API prefix, by its slug. */
const WS = 'ws-owner'
const BASE = '/w/owner'
const PERSON = { id: OWNER, name: 'Owner', email: 'owner@goblin.test' }
const MEMBERSHIP = { id: WS, name: "Owner's workspace", slug: 'owner', role: 'owner', members: 1 } as const
/** One MCP client the owner connected, reaching their workspace (ADR 0097). */
const CLIENT_VIEW = {
  clientId: 'client.1',
  name: 'Claude',
  scopes: ['goblin:topics'],
  reach: { all: false, workspaces: [{ id: WS, slug: 'owner', name: "Owner's workspace" }] },
}
const MEMBER_VIEW = {
  userId: OWNER,
  name: 'Owner',
  email: 'owner@goblin.test',
  role: 'owner',
  joinedAt: '2026-10-21T00:00:00.000Z',
} as const
const INVITATION = {
  id: 'a'.repeat(32),
  email: 'ana@goblin.test',
  role: 'member',
  state: 'pending',
  invitedBy: 'Owner',
  expiresAt: '2026-10-28T00:00:00.000Z',
} as const
const SECRET = 'secret-words'
const KEY = `gbk_${'k'.repeat(64)}`

const KEY_VIEW = {
  id: 'key-1',
  name: 'svc',
  scopes: [],
  servers: ['mycut'],
  origins: [],
  createdAt: '2026-10-20T00:00:00.000Z',
}

/** The account's records, keeping the crash points asked for: each one's user, if the report came with a session. */
const accountRecords = (crash: AccountRecords['crash'] = () => Effect.void) => {
  const crashes: (string | undefined)[] = []
  const records: AccountRecords = {
    members: fake<AccountRecords['members']>({
      list: () => Effect.succeed([MEMBER_VIEW]),
      invite: (_actor, _person, input) =>
        Effect.succeed(input.emails.map((email) => ({ invitation: { ...INVITATION, email }, mailed: true }))),
      preview: (id) =>
        id === INVITATION.id
          ? Effect.succeed({ ...INVITATION, workspace: MEMBERSHIP.name })
          : Effect.fail(new NotFound({ what: 'invitation' })),
    }),
    workspaces: () => Effect.succeed([MEMBERSHIP]),
    createWorkspace: (_user, input) => Effect.succeed({ id: 'ws-new', ...input, role: 'owner', members: 1 }),
    updateWorkspace: () => Effect.die(new Error('no updates in this fixture')),
    deleteWorkspace: () => Effect.void,
    clients: () => Effect.succeed([CLIENT_VIEW]),
    setClientReach: (_person, _clientId, reach) => Effect.succeed(reach),
    revokeClient: () => Effect.void,
    keys: () => Effect.succeed([]),
    createKey: () => Effect.die(new Error('no keys in this fixture')),
    updateKey: (_workspace, _user, keyId, change) =>
      keyId === 'key-1'
        ? Effect.succeed({
            before: { ...KEY_VIEW, scopes: ['topics', 'personas'] },
            after: {
              ...KEY_VIEW,
              scopes: change.scopes ?? ['topics', 'personas'],
              origins: change.origins ?? [],
            },
          })
        : Effect.fail(new NotFound({ what: 'key' })),
    revokeKey: () => Effect.void,
    crash: (report, userId) => {
      crashes.push(Option.getOrUndefined(userId))
      return crash(report, userId)
    },
  }
  return { records, crashes }
}

/**
 * The deployment as the edge sees it, with an agent that records what reached it (and which workspace's) and answers
 * `reply`. The owner is a member of `WS` alone, with `role`.
 */
const deployment = (
  reply: () => Response = () => Response.json({ ok: true }),
  { records, crashes } = accountRecords(),
  role: 'owner' | 'admin' | 'member' = 'owner',
) => {
  const seen: Request[] = []
  const agents: string[] = []
  const edge: Edge = {
    origin: APP,
    session: (request) => {
      const cookie = request.headers.get('cookie')
      if (request.headers.has('authorization') || cookie === null)
        return Effect.fail(new Unauthenticated({ reason: 'session required' }))
      return Effect.succeed(PERSON)
    },
    key: (key) =>
      key === KEY
        ? Effect.succeed({
            workspaceId: WS,
            keyId: 'key-1',
            scopes: ['topics', 'conversations'],
            servers: ['mycut'],
            origins: [],
          })
        : Effect.fail(new Unauthenticated({ reason: 'key' })),
    membership: (userId, slug) =>
      Effect.succeed(userId === OWNER && slug === MEMBERSHIP.slug ? { ...MEMBERSHIP, role } : undefined),
    membershipOf: (userId, workspaceId) =>
      Effect.succeed(userId === OWNER && workspaceId === WS ? { ...MEMBERSHIP, role } : undefined),
    agent: (workspaceId) => ({
      fetch: async (request) => {
        seen.push(request)
        agents.push(workspaceId)
        return reply()
      },
    }),
    records,
  }
  return { seen, agents, edge, crashes }
}

const built = Effect.runPromise(makeEdgeHttp)
/** One request through the edge: its response and the lines it logged. */
const through = async (
  side: 'account' | 'workspace' | 'signIn' | 'owner',
  request: Request,
  edge: Edge,
): Promise<{ readonly response: Response; readonly lines: readonly unknown[] }> => {
  const http = await built
  const { value, lines } = await Effect.runPromise(withLines(http[side](request, edge)))
  return { response: value, lines: lines.map(({ line }) => line) }
}
/** One request through one of the Worker's own routes, answered by `serve`: its response and the lines it logged. */
const route = async (request: Request, serve: () => Promise<Response>) => {
  const http = await built
  const { value, lines } = await Effect.runPromise(withLines(http.route(request, () => attempt(serve))))
  return { response: value, lines: lines.map(({ line }) => line) }
}

const write = (path: string, init: { headers?: Record<string, string>; body?: BodyInit; method?: string } = {}) =>
  new Request(`${APP}${path}`, {
    method: init.method ?? 'POST',
    headers: { cookie: 'session=owner', origin: APP, 'x-goblin-csrf': '1', ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })

describe("a member's forward (ADR 0089)", () => {
  it('forwards only the allowlisted headers, with the edge reference, the owner mark and the member, never a credential', async () => {
    const { seen, agents, edge } = deployment()
    const request = write(`${BASE}/api/mcp/myplan/tools/call?x=1`, {
      headers: {
        'cf-ray': '8c1f2a3b4d5e6f70-AMS',
        'content-type': 'application/json',
        'x-goblin-request': 'r1b2c3d4',
        'x-goblin-operation': 'op-1',
        'x-mcp-caller': 'app',
        'x-goblin-ref': 'forged',
        'x-goblin-forwarded': 'forged',
        'x-goblin-member': '{"user":"forged","role":"owner"}',
      },
      body: JSON.stringify({ name: 'x' }),
    })
    const { response } = await through('workspace', request, edge)
    expect(response.headers.get('x-goblin-ref')).toBe('8c1f2a3b4d5e6f70-AMS')
    const [forwarded] = seen
    expect(agents).toEqual([WS])
    expect(forwarded?.url).toBe('https://agent/api/mcp/myplan/tools/call?x=1')
    expect(forwarded?.method).toBe('POST')
    expect(Object.fromEntries(forwarded?.headers ?? [])).toEqual({
      'content-type': 'application/json',
      'x-goblin-request': 'r1b2c3d4',
      'x-goblin-operation': 'op-1',
      'x-mcp-caller': 'app',
      'x-goblin-ref': '8c1f2a3b4d5e6f70-AMS',
      'x-goblin-forwarded': 'owner',
      'x-goblin-member': JSON.stringify({ user: OWNER, role: 'owner', name: 'Owner', shared: false }),
    })
    expect(await forwarded?.json()).toEqual({ name: 'x' })
  })

  it('tells a member path from any other', () => {
    expect([`${BASE}/api/topics`, '/w/a_b-1/api/x'].every(isWorkspacePath)).toBe(true)
    expect(['/api/topics', `${BASE}/api`, `${BASE}/topics`, '/w//api/x', '/w/a b/api/x'].some(isWorkspacePath)).toBe(
      false,
    )
  })

  // Whatever a path says, the agent sees only `/api/*` as the parsed URL names it, marked as the owner's forward: an
  // internal path never reaches it from a member's session (the agent refuses a marked one too, `internal.test.ts`).
  it.each([
    [`${BASE}/internal/x`, 404],
    [`${BASE}/api/../internal/x`, 404],
    [`${BASE}/api/%2e%2e/internal/x`, 404],
    [`${BASE}/api/%2E%2E/internal/x`, 404],
    [`${BASE}/api/.%2e/internal/x`, 404],
    [`${BASE}/API/internal/x`, 404],
    [`${BASE}/api%2Finternal/x`, 404],
    [`${BASE}/api\\..\\internal\\x`, 404],
    [`${BASE}/api/workspaces`, 404],
    [`${BASE}/api/internal/x`, 200],
    [`${BASE}/api/%2F..%2Finternal/x`, 200],
  ] as const)('forwards %s only under /api/ and marked as the owner', async (path, status) => {
    const { seen, edge } = deployment()
    const request = new Request(`${APP}${path}`, {
      headers: { cookie: 'session=owner', 'x-goblin-forwarded': 'internal' },
    })
    const { response } = await through('workspace', request, edge)
    expect(response.status).toBe(status)
    if (status === 404) expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    for (const forwarded of seen) {
      expect(new URL(forwarded.url).pathname).toMatch(/^\/api\//u)
      expect(forwarded.headers.get('x-goblin-forwarded')).toBe('owner')
    }
    expect(seen).toHaveLength(status === 404 ? 0 : 1)
  })

  it("hands the agent's redirect to the browser, at the workspace's pages, instead of following it into the agent", async () => {
    const { seen, edge } = deployment(
      () => new Response(null, { status: 302, headers: { location: `${APP}/connections?connected=sidequest` } }),
    )
    const request = new Request(`${APP}${BASE}/api/mcp/oauth/callback?state=s&code=c`, {
      headers: { cookie: 'session=owner' },
    })
    const { response } = await through('workspace', request, edge)
    expect(seen.map((forwarded) => forwarded.redirect)).toEqual(['manual'])
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}${BASE}/connections?connected=sidequest`)
  })

  it("brings an outbound sign-in back to the workspace its state names, after the person's membership of it", async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: `${APP}/start/connect?connected=x` } })
    const { seen, agents, edge } = deployment(redirect)
    const state = `${WS}.${crypto.randomUUID()}`
    const back = (query: string, headers: Record<string, string> = { cookie: 'session=owner' }) =>
      through('signIn', new Request(`${APP}/api/mcp/oauth/callback?${query}`, { headers }), edge)
    const { response } = await back(`code=c&state=${state}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}${BASE}/start/connect?connected=x`)
    expect(agents).toEqual([WS])
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/mcp/oauth/callback')
    expect(new URL(seen[0]?.url ?? '').searchParams.get('state')).toBe(state)
    expect(JSON.parse(seen[0]?.headers.get('x-goblin-member') ?? '{}')).toMatchObject({ user: OWNER, role: 'owner' })
    // Another workspace's sign-in, a state goblin did not make and no session reach no agent. The person who is not
    // in the sign-in's workspace is sent to a page that says so, which names no workspace (ADR 0096).
    const elsewhere = `ws-other.${crypto.randomUUID()}`
    const refused = [
      await back(`code=c&state=${elsewhere}`),
      await back('code=c&state=s'),
      await back(`code=c&state=${state}`, {}),
    ]
    expect(refused.map(({ response: each }) => each.status)).toEqual([302, 404, 401])
    expect(refused[0]?.response.headers.get('location')).toBe(`${APP}/connect-elsewhere`)
    expect(await refused[1]?.response.json()).toMatchObject({ error: { code: 'not_found', what: 'workspace' } })
    expect(agents).toEqual([WS])
  })

  it('makes up a reference where there is no cf-ray', async () => {
    const { seen, edge } = deployment()
    await through('workspace', new Request(`${APP}${BASE}/api/topics`, { headers: { cookie: 'session=owner' } }), edge)
    expect(seen[0]?.headers.get('x-goblin-ref')).toMatch(/^[0-9a-f]{16}$/u)
  })

  it.each([
    ['no session', new Request(`${APP}${BASE}/api/topics`), 401, 'unauthenticated'],
    [
      'a bearer token beside the cookie',
      new Request(`${APP}${BASE}/api/topics`, { headers: { cookie: 'session=owner', authorization: 'Bearer x' } }),
      401,
      'unauthenticated',
    ],
    [
      'a write without the CSRF header',
      write(`${BASE}/api/topics/7`, { method: 'PATCH', headers: { 'x-goblin-csrf': '' } }),
      403,
      'forbidden',
    ],
    [
      'a write from another site',
      write(`${BASE}/api/topics`, { headers: { origin: 'https://evil.test' } }),
      403,
      'forbidden',
    ],
    [
      'a workspace the person is not a member of',
      new Request(`${APP}/w/ws-someone-else/api/topics`, { headers: { cookie: 'session=owner' } }),
      404,
      'not_found',
    ],
    [
      'a session on a path with no workspace',
      new Request(`${APP}/api/topics`, { headers: { cookie: 'session=owner' } }),
      404,
      'not_found',
    ],
  ] as const)('refuses %s without waking an agent', async (_case, request, status, code) => {
    const { seen, edge } = deployment()
    const side = isWorkspacePath(new URL(request.url).pathname) ? 'workspace' : 'owner'
    const { response } = await through(side, request, edge)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(seen).toHaveLength(0)
  })

  it('refuses a JSON body over 64 KB without waking the agent, but streams a file upload through', async () => {
    const { seen, edge } = deployment()
    const big = 'x'.repeat(70_000)
    const { response } = await through(
      'workspace',
      write(`${BASE}/api/topics`, { body: big, headers: { 'cf-ray': 'ray-413' } }),
      edge,
    )
    expect(response.status).toBe(413)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-413')
    expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large', limit: 65_536, ref: 'ray-413' } })
    expect(seen).toHaveLength(0)
    await through('workspace', write(`${BASE}/api/files/uploads/a.txt`, { method: 'PUT', body: big }), edge)
    expect(await seen[0]?.text()).toHaveLength(70_000)
  })

  it('logs one content-free line for a failure the agent answered, naming the endpoint and the agent', async () => {
    const { edge } = deployment(() =>
      Response.json(envelopeOf(new NotFound({ what: SECRET, ref: 'ray-1' })), { status: 404 }),
    )
    const request = write(`${BASE}/api/topics/7`, {
      method: 'PATCH',
      headers: { 'cf-ray': 'ray-1', 'x-goblin-request': 'r1', 'x-goblin-operation': 'op-1' },
      body: JSON.stringify({ name: SECRET }),
    })
    const { response, lines } = await through('workspace', request, edge)
    expect(response.status).toBe(404)
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'http.failure',
        route: 'topics.update',
        method: 'PATCH',
        status: 404,
        code: 'not_found',
        ref: 'ray-1',
        request: 'r1',
        operation: 'op-1',
        agent: WS,
      },
    ])
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  it('names a path that is no endpoint by its area only', async () => {
    const { edge } = deployment()
    const { lines } = await through('workspace', new Request(`${APP}${BASE}/api/agent-apps/${SECRET}/nothing`), edge)
    expect(lines).toMatchObject([{ route: '/api/agent-apps/{path}', status: 401, code: 'unauthenticated' }])
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })
})

describe("a server's API key (ADR 0081)", () => {
  /** A request a server sends with `key`: no cookie, no Origin, no CSRF header. */
  const server = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Request(`${APP}${path}`, {
      method: init.method ?? 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    })

  it("reaches its workspace's agent without a CSRF header, forwarding its grant and never the key, a member or an App mark", async () => {
    const { seen, agents, edge } = deployment()
    const request = server('/api/topics', {
      headers: {
        'x-mcp-caller': 'app',
        'x-goblin-caller': '{"kind":"key","keyId":"forged","scopes":["personas"],"servers":[]}',
        'x-goblin-member': '{"user":"forged","role":"owner"}',
      },
      body: JSON.stringify({ name: 'x' }),
    })
    const { response } = await through('owner', request, edge)
    expect(response.status).toBe(200)
    expect(agents).toEqual([WS])
    const [forwarded] = seen
    expect(forwarded?.headers.get('authorization')).toBeNull()
    expect(forwarded?.headers.get('x-mcp-caller')).toBeNull()
    expect(forwarded?.headers.get('x-goblin-member')).toBeNull()
    expect(forwarded?.headers.get('x-goblin-forwarded')).toBe('owner')
    expect(JSON.parse(forwarded?.headers.get('x-goblin-caller') ?? '')).toEqual({
      kind: 'key',
      keyId: 'key-1',
      scopes: ['topics', 'conversations'],
      servers: ['mycut'],
      origins: [],
    })
  })

  it('never forwards a grant a session request names', async () => {
    const { seen, edge } = deployment()
    const request = write(`${BASE}/api/topics`, {
      headers: { 'x-goblin-caller': '{"kind":"key","keyId":"forged","scopes":[],"servers":[]}' },
    })
    await through('workspace', request, edge)
    expect(seen[0]?.headers.get('x-goblin-caller')).toBeNull()
  })

  it.each([
    [
      'an unknown key',
      server('/api/topics', { headers: { authorization: `Bearer gbk_${'z'.repeat(64)}` } }),
      401,
      'key',
    ],
    ['a key with a cookie', server('/api/topics', { headers: { cookie: 'session=owner' } }), 403, 'key_browser'],
    ['a key with an Origin', server('/api/topics', { headers: { origin: APP } }), 403, 'key_browser'],
    ['an endpoint no key reaches', server('/api/agent/resident', { method: 'GET' }), 403, 'scope'],
    ['a scope the key lacks', server('/api/personas', { body: '{}' }), 403, 'scope'],
    ['a file upload', server('/api/files/uploads/a.txt', { method: 'PUT', body: 'x' }), 403, 'scope'],
    ['a path that is no endpoint', server('/api/nothing/here', { method: 'GET' }), 403, 'scope'],
    [
      'an inbound OAuth token',
      server('/api/topics', { headers: { authorization: 'Bearer eyJhbGciOi.eyJzdWIiOi.c2ln' } }),
      404,
      'route',
    ],
  ] as const)('refuses %s without waking the agent', async (_case, request, status, reason) => {
    const { seen, edge } = deployment()
    const { response } = await through('owner', request, edge)
    expect(response.status).toBe(status)
    expect(JSON.stringify(await response.json())).toContain(reason)
    expect(seen).toHaveLength(0)
  })

  it("passes its agent's rate-limit refusal on with Retry-After (ADR 0085)", async () => {
    const limited = new Unauthenticated({ reason: 'rate_limited', retryAfter: 17 })
    const { edge } = deployment(() => Response.json(envelopeOf(limited), { status: 401 }))
    const { response } = await through('owner', server('/api/topics', { method: 'GET' }), edge)
    expect(response.status).toBe(401)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(await response.json()).toMatchObject({ error: { reason: 'rate_limited', retryAfter: 17 } })
  })

  it('never reaches the account APIs: a key cannot list, make or change keys, nor use a member path', async () => {
    const { seen, edge } = deployment()
    for (const request of [
      server(`${BASE}/api/keys`, { method: 'GET' }),
      server(`${BASE}/api/keys`, { body: '{}' }),
      server(`${BASE}/api/keys/key-1`, { method: 'PATCH', body: JSON.stringify({ scopes: ['inspect'] }) }),
      server(`${BASE}/api/topics`, { method: 'GET' }),
    ]) {
      const { response } = await through('workspace', request, edge)
      expect(response.status).toBe(401)
    }
    expect((await through('account', server('/api/workspaces', { method: 'GET' }), edge)).response.status).toBe(401)
    expect(seen).toHaveLength(0)
  })
})

/** A manager's change of key `key-1`, as Settings sends it. */
const patchKey = (body: unknown) =>
  write(`${BASE}/api/keys/key-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('the account APIs in the Worker', () => {
  it("gives a workspace's key new scopes and audits who did it, never for a foreign Origin (ADR 0084)", async () => {
    const { edge } = deployment()
    const change = JSON.stringify({ scopes: ['topics', 'personas', 'inspect'] })
    const patch = (headers: Record<string, string> = {}) =>
      write(`${BASE}/api/keys/key-1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: change,
      })
    const { response, lines } = await through('workspace', patch(), edge)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'key-1', scopes: ['topics', 'personas', 'inspect'] })
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'api_key',
        kind: 'scopes',
        id: 'key-1',
        agent: WS,
        by: OWNER,
        scopes: ['topics', 'personas', 'inspect'],
        'scopes.before': ['topics', 'personas'],
      }),
    )
    expect((await through('workspace', patch({ origin: 'https://evil.test' }), edge)).response.status).toBe(403)
    const gone = write(`${BASE}/api/keys/key-9`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: change,
    })
    expect((await through('workspace', gone, edge)).response.status).toBe(404)
    const empty = write(`${BASE}/api/keys/key-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: [] }),
    })
    expect((await through('workspace', empty, edge)).response.status).toBe(400)
  })

  it('gives a key MCP origins and audits only how many, never naming one; a change naming nothing is refused (ADR 0091)', async () => {
    const { edge } = deployment()
    const origins = [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit'] }]
    const { response, lines } = await through('workspace', patchKey({ origins }), edge)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'key-1', origins })
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'api_key', kind: 'origins', id: 'key-1', agent: WS, by: OWNER, count: 1 }),
    )
    expect(JSON.stringify(lines)).not.toContain('swarmm')
    expect(lines).not.toContainEqual(expect.objectContaining({ kind: 'scopes' }))
    expect((await through('workspace', patchKey({}), edge)).response.status).toBe(400)
  })

  it("keeps a workspace's keys from a member who is not an owner or admin", async () => {
    const { edge } = deployment(undefined, accountRecords(), 'member')
    const list = new Request(`${APP}${BASE}/api/keys`, { headers: { cookie: 'session=owner' } })
    const { response } = await through('workspace', list, edge)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
  })

  it("lists a workspace's members for any member, and invites only for an owner or admin (ADR 0093)", async () => {
    const owner = deployment()
    const list = new Request(`${APP}${BASE}/api/members`, { headers: { cookie: 'session=owner' } })
    expect(await (await through('workspace', list, owner.edge)).response.json()).toEqual([MEMBER_VIEW])
    const invite = (edge: Edge) =>
      through(
        'workspace',
        write(`${BASE}/api/members/invitations`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ emails: ['ana@goblin.test'], role: 'member' }),
        }),
        edge,
      )
    const sent = (await invite(owner.edge)).response
    expect(sent.status).toBe(201)
    expect(await sent.json()).toEqual([{ invitation: INVITATION, mailed: true }])
    const member = deployment(undefined, accountRecords(), 'member')
    expect(await (await through('workspace', list, member.edge)).response.json()).toEqual([MEMBER_VIEW])
    const refused = (await invite(member.edge)).response
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
    expect([...owner.seen, ...member.seen]).toHaveLength(0)
  })

  it("shows an invitation's link to a visitor with no session, and nothing else of the person's", async () => {
    const { edge } = deployment()
    const preview = await through('account', new Request(`${APP}/api/invitations/${INVITATION.id}`), edge)
    expect(preview.response.status).toBe(200)
    expect(await preview.response.json()).toMatchObject({ workspace: MEMBERSHIP.name, email: 'ana@goblin.test' })
    const unknown = await through('account', new Request(`${APP}/api/invitations/${'b'.repeat(32)}`), edge)
    expect(unknown.response.status).toBe(404)
    const mine = await through('account', new Request(`${APP}/api/invitations`), edge)
    expect(mine.response.status).toBe(401)
    const accept = await through(
      'account',
      new Request(`${APP}/api/invitations/${INVITATION.id}/accept`, {
        method: 'POST',
        headers: { origin: APP, 'x-goblin-csrf': '1' },
      }),
      edge,
    )
    expect(accept.response.status).toBe(401)
  })

  it("answers a person's workspaces, and makes one", async () => {
    const { edge } = deployment()
    const list = new Request(`${APP}/api/workspaces`, { headers: { cookie: 'session=owner' } })
    expect(await (await through('account', list, edge)).response.json()).toEqual([MEMBERSHIP])
    const create = write('/api/workspaces', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Swarmm', slug: 'swarmm' }),
    })
    const created = (await through('account', create, edge)).response
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: 'ws-new', name: 'Swarmm', slug: 'swarmm', role: 'owner', members: 1 })
    const badSlug = write('/api/workspaces', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Swarmm', slug: 'Not A Slug' }),
    })
    expect((await through('account', badSlug, edge)).response.status).toBe(400)
  })

  const report = {
    route: '/c/$chatId',
    name: 'TypeError',
    frames: ['https://goblin.test/assets/index-3f2a.js?v=1:1:2345'],
    build: 'd5ac526',
    ref: '7f3a9c12',
  }

  it('takes a crash report with the CSRF header and no session, and logs it without its query', async () => {
    const { edge, crashes } = deployment()
    const request = new Request(`${APP}/api/client-errors`, {
      method: 'POST',
      headers: { origin: APP, 'x-goblin-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    const { response, lines } = await through('account', request, edge)
    expect(response.status).toBe(204)
    expect(crashes).toEqual([undefined])
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'client_error',
        route: '/c/$chatId',
        name: 'TypeError',
        frames: ['https://goblin.test/assets/index-3f2a.js:1:2345'],
        build: 'd5ac526',
        ref: '7f3a9c12',
      },
    ])
  })

  it("writes a signed-in report's point under its person, and still takes a report whose point cannot be written", async () => {
    const body = JSON.stringify(report)
    const signedIn = deployment()
    const withSession = write('/api/client-errors', { headers: { 'content-type': 'application/json' }, body })
    expect((await through('account', withSession, signedIn.edge)).response.status).toBe(204)
    expect(signedIn.crashes).toEqual([OWNER])
    const failing = deployment(
      undefined,
      accountRecords(() => Effect.fail(new FlowPointFailure({ step: 'write', cause: 'x' }))),
    )
    const { response, lines } = await through(
      'account',
      write('/api/client-errors', { headers: { 'content-type': 'application/json' }, body }),
      failing.edge,
    )
    expect(response.status).toBe(204)
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'failure', where: 'http.clientErrors', 'error.type': 'FlowPointFailure' }),
    )
  })

  it("puts a crash's point in the flow layout: content-free, indexed by the agent's hash only when there is one", () => {
    const point = crashPoint(report, 'a1b2c3d4e5f60718', 'dev')
    expect(point).toEqual({
      indexes: ['a1b2c3d4e5f60718'],
      blobs: ['client_error', 'app', 'owner', '', 'error', 'TypeError', 'dev', 'd5ac526', ''],
      doubles: [1, 0, 0, 0],
    })
    expect(crashPoint(report, undefined, 'dev').indexes).toEqual([])
    expect(JSON.stringify(point)).not.toContain('/c/')
    expect(JSON.stringify(point)).not.toContain('index-3f2a')
  })

  it('refuses a crash report without the CSRF header, or one that could carry a message', async () => {
    const { edge } = deployment()
    const json = { 'content-type': 'application/json' }
    const forged = write('/api/client-errors', {
      headers: { ...json, 'x-goblin-csrf': '' },
      body: JSON.stringify(report),
    })
    expect((await through('account', forged, edge)).response.status).toBe(403)
    const message = write('/api/client-errors', {
      headers: json,
      body: JSON.stringify({ ...report, name: `Cannot read ${SECRET}` }),
    })
    const { response, lines } = await through('account', message, edge)
    expect(response.status).toBe(400)
    expect(JSON.stringify(lines)).not.toContain(SECRET)
    const big = write('/api/client-errors', { headers: json, body: 'x'.repeat(5000) })
    expect((await through('account', big, edge)).response.status).toBe(413)
  })

  it("answers a person's clients and their reach, changes one's reach and revokes one, without waking an agent", async () => {
    const { seen, edge } = deployment()
    const list = new Request(`${APP}/api/clients`, { headers: { cookie: 'session=owner' } })
    expect(await (await through('account', list, edge)).response.json()).toEqual([CLIENT_VIEW])
    const reach = write('/api/clients/client.1/reach', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: false, workspaces: [WS] }),
    })
    expect(await (await through('account', reach, edge)).response.json()).toEqual({ all: false, workspaces: [WS] })
    const revoke = write('/api/clients/client.1', { method: 'DELETE' })
    expect(await (await through('account', revoke, edge)).response.json()).toEqual({ revoked: true })
    const forged = write('/api/clients/client.1', { method: 'DELETE', headers: { 'x-goblin-csrf': '' } })
    expect((await through('account', forged, edge)).response.status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('owns its paths: anything else under them is a 404 in the envelope', async () => {
    expect(['/api/workspaces', '/api/workspaces/x', '/api/clients', '/api/client-errors'].every(isAccountPath)).toBe(
      true,
    )
    expect(['/api/clientsx', '/api/keys', '/api/topics', '/api/workspacesx'].some(isAccountPath)).toBe(false)
    const { edge } = deployment()
    const { response } = await through('account', new Request(`${APP}/api/workspaces/x/y/z`), edge)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
    const unknown = new Request(`${APP}${BASE}/api/keys/x/y/z`, { headers: { cookie: 'session=owner' } })
    expect((await through('workspace', unknown, edge)).response.status).toBe(404)
  })
})

describe("the Worker's own routes", () => {
  it('answers with the API headers and the reference', async () => {
    const request = new Request(`${APP}/mcp`, { method: 'POST', headers: { 'cf-ray': 'ray-4' } })
    const { response, lines } = await route(request, async () => Response.json({ ok: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(lines).toEqual([])
  })

  it('answers a failure of ours as the internal envelope, its line naming only the route area', async () => {
    const request = new Request(`${APP}/hooks/myagent/${SECRET}/token`, {
      method: 'POST',
      headers: { 'cf-ray': 'ray-5' },
    })
    const { response, lines } = await route(request, () => Promise.reject(new Error(`token=${SECRET}`)))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'internal',
        message: 'Something went wrong on our side.',
        recovery: 'Try again.',
        reason: 'unexpected',
        ref: 'ray-5',
      },
    })
    expect(lines).toContainEqual({
      level: 'error',
      event: 'http.failure',
      route: '/hooks/myagent/{path}',
      method: 'POST',
      status: 500,
      code: 'internal',
      ref: 'ray-5',
    })
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  it('answers a typed refusal in its envelope, logged as information', async () => {
    const request = new Request(`${APP}/internal/recent`, { headers: { 'cf-ray': 'ray-6' } })
    const { response, lines } = await route(request, () => Promise.reject(new NotFound({ what: 'route' })))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route', ref: 'ray-6' } })
    expect(lines).toMatchObject([{ level: 'info', route: '/internal/recent', status: 404, code: 'not_found' }])
  })
})
