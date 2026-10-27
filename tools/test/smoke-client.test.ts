import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DevClient, type Step } from '../../scripts/smoke-client.ts'
import { idleAfter, openingOf } from '../../scripts/smoke-entries.ts'

const OWNER = 'owner@example.com'
const COOKIE = 'better-auth.session_token=secret-value'
const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = []

const answer = (response: ServerResponse, status: number, body: unknown, ref?: string): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...(ref === undefined ? {} : { 'x-goblin-ref': ref }),
  })
  response.end(JSON.stringify(body))
}

/** Chat 1's stream opens with its snapshots, a run in flight, then stays open. */
const OPENING = [
  { type: 'MESSAGES_SNAPSHOT', messages: [] },
  { type: 'STATE_SNAPSHOT', snapshot: { queue: [] } },
  { type: 'RUN_STARTED', threadId: '1', runId: '1:4' },
]

/**
 * A stand-in for the stage: the session read, the owner's one workspace, two owner endpoints under it (ADR 0089), a
 * chat's stream, and a failure in the error envelope.
 */
const server = createServer((request, response) => {
  seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
  const route = `${request.method} ${request.url}`
  if (route === 'GET /api/auth/get-session')
    return answer(response, 200, { user: { email: OWNER }, session: { expiresAt: '2999-01-01T00:00:00Z' } })
  if (route === 'GET /api/workspaces')
    return answer(response, 200, [{ id: 'ws-1', name: "Owner's workspace", slug: 'owner', role: 'owner' }])
  if (route === 'GET /w/owner/api/agent/resident') return answer(response, 200, { state: 'active' }, 'ref-resident')
  if (route === 'PUT /w/owner/api/agent/model')
    return answer(response, 200, { current: 'm', default: 'm', options: [] }, 'ref-model')
  if (route === 'GET /w/owner/api/conversations/1/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-goblin-ref': 'ref-stream' })
    response.write(OPENING.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    return
  }
  const missing = { error: { code: 'not_found', message: 'That does not exist.', what: 'chat', ref: 'ref-missing' } }
  return answer(response, 404, missing, 'ref-missing')
})

const dir = mkdtempSync(path.join(tmpdir(), 'goblin-smoke-client-'))
let dev: DevClient
const steps: Step[] = []

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  const origin = `http://localhost:${address.port}`
  const file = path.join(dir, 'session.json')
  writeFileSync(file, JSON.stringify({ origin, cookie: COOKIE }))
  chmodSync(file, 0o600)
  dev = new DevClient(new URL(origin), steps)
  await dev.useSession(file, OWNER)
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('DevClient', () => {
  it('sends typed owner calls with the session, a request id and CSRF on writes, and logs each answer', async () => {
    seen.length = 0
    expect((await dev.owner((api) => api.resident.status())).state).toBe('active')
    expect((await dev.owner((api) => api.agent.chooseModel({ payload: { model: 'm' } }))).current).toBe('m')
    const [read, write] = seen
    expect([read?.url, write?.url]).toEqual(['/w/owner/api/agent/resident', '/w/owner/api/agent/model'])
    expect(read?.headers).toMatchObject({ cookie: COOKIE, origin: expect.stringMatching(/^http:\/\/localhost:/u) })
    expect(read?.headers['x-goblin-request']).toMatch(/^[0-9a-f]{8}$/u)
    expect(read?.headers['x-goblin-csrf']).toBeUndefined()
    expect(write?.headers['x-goblin-csrf']).toBe('1')
    expect(steps.slice(-2)).toEqual([
      { step: 'GET /api/agent/resident', status: 200, ref: 'ref-resident' },
      { step: 'PUT /api/agent/model', status: 200, ref: 'ref-model' },
    ])
  })

  it('reports a refused call by its tag, never its text, and logs its reference', async () => {
    await expect(dev.owner((api) => api.conversations.composer({ params: { id: '7' } }))).rejects.toThrow(
      /^request_failed: NotFound$/u,
    )
    expect(steps.at(-1)).toEqual({ step: 'GET /api/conversations/7/composer', status: 404, ref: 'ref-missing' })
  })

  it("reads a chat's stream directly: its opening, and whether the chat is idle by it", async () => {
    const response = await dev.send('/api/conversations/1/stream', { headers: { accept: 'text/event-stream' } })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    if (response.body === null) throw new Error('a stream without a body')
    const opening = await openingOf(response.body)
    expect(opening).toEqual(OPENING)
    expect(idleAfter(opening)).toBe(false)
    expect(idleAfter(opening.slice(0, 2))).toBe(true)
    expect(steps.at(-1)).toEqual({ step: 'GET /api/conversations/1/stream', status: 200, ref: 'ref-stream' })
  })

  it("sends a person's own paths as they are, a member's under the workspace unless told not to", async () => {
    seen.length = 0
    await dev.send('/api/install/app-1')
    await dev.send('/api/grants/clients/c-1', { method: 'PUT' })
    await dev.send('/api/installations')
    await dev.send('/api/topics', { workspace: false })
    expect(seen.map((request) => request.url)).toEqual([
      '/api/install/app-1',
      '/api/grants/clients/c-1',
      '/w/owner/api/installations',
      '/api/topics',
    ])
    expect(dev.slug).toBe('owner')
  })

  it('refuses a session that is not the expected person', async () => {
    const other = new DevClient(new URL(dev.origin), [])
    await expect(other.useCookie(COOKIE, 'someone@example.com')).rejects.toThrow(/^session_owner_mismatch$/u)
  })

  it('leaves the session out of a request that asks for it', async () => {
    seen.length = 0
    await dev.send('/health', { owner: false })
    expect(seen[0]?.headers.cookie).toBeUndefined()
    expect(steps.at(-1)).toEqual({ step: 'GET /health', status: 404, ref: 'ref-missing' })
  })
})
