import { afterEach, expect, test } from 'bun:test'
import { Fixture } from '../fixture'
import { startServer } from '../server'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function bridge() {
  const token = crypto.randomUUID()
  const server = startServer({ token })
  disposers.push(() => server.stop())
  const origin = `http://127.0.0.1:${server.port}`
  const headers = { authorization: `Bearer ${token}`, 'x-goblin-shell': 'browser', 'content-type': 'application/json' }
  const command = (body: object) =>
    fetch(`${origin}/bridge/command`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { origin, headers, command }
}

test('fixture grows text, stops without discarding it, and deduplicates the same operation', async () => {
  const fixture = new Fixture(() => {}, 2)
  disposers.push(() => fixture.dispose())
  const command = { type: 'send', text: 'hello', operationId: 'operation-00000001' } as const
  fixture.command(command)
  await delay(15)
  const first = fixture.view().messages.at(-1)?.text ?? ''
  expect(first.length).toBeGreaterThan(0)
  fixture.command({ type: 'stop' })
  await delay(15)
  expect(fixture.view().messages.at(-1)?.text).toBe(first)
  fixture.command(command)
  expect(fixture.view().messages.filter((m) => m.id === command.operationId)).toHaveLength(1)
  expect(fixture.view().streaming).toBe(false)
})
test('switching chat cancels old chunks and returning preserves partial history', async () => {
  const fixture = new Fixture(() => {}, 2)
  disposers.push(() => fixture.dispose())
  fixture.command({ type: 'send', text: 'hello', operationId: 'operation-00000002' })
  await delay(10)
  const partial = fixture.view().messages.at(-1)?.text
  fixture.command({ type: 'select', id: 'mobile' })
  await delay(15)
  expect(fixture.view().messages).toHaveLength(2)
  fixture.command({ type: 'select', id: 'desktop' })
  expect(fixture.view().messages.at(-1)?.text).toBe(partial)
})
test('bridge refuses missing capabilities, hostile origins and malformed commands', async () => {
  const b = bridge()
  expect((await fetch(`${b.origin}/bridge/state`)).status).toBe(401)
  expect(
    (await fetch(`${b.origin}/bridge/state`, { headers: { ...b.headers, origin: 'https://untrusted.example' } }))
      .status,
  ).toBe(403)
  expect(
    (await fetch(`${b.origin}/bridge/state`, { headers: { ...b.headers, 'x-goblin-shell': 'unknown' } })).status,
  ).toBe(400)
  expect((await b.command({ type: 'send', text: 'hello', operationId: '../invalid' })).status).toBe(400)
  expect((await b.command({ type: 'proxy', url: 'https://untrusted.example' })).status).toBe(400)
})
test('profiles are independent; restarting a stream gets a fresh snapshot', async () => {
  const b = bridge()
  await b.command({ type: 'new' })
  const browser = await (await fetch(`${b.origin}/bridge/state`, { headers: b.headers })).json()
  const gpui = await (
    await fetch(`${b.origin}/bridge/state`, { headers: { ...b.headers, 'x-goblin-shell': 'gpui' } })
  ).json()
  expect(browser.messages).toHaveLength(0)
  expect(gpui.messages).toHaveLength(4)
  const abort = new AbortController()
  const response = await fetch(`${b.origin}/bridge/events`, { headers: b.headers, signal: abort.signal })
  const reader = response.body?.getReader()
  const first = await reader?.read()
  expect(new TextDecoder().decode(first?.value)).toContain(browser.selected)
  await reader?.cancel()
  abort.abort()
})
test('live owner session remains in companion and uses existing origin, CSRF and operation contract', async () => {
  const calls: {
    path: string
    cookie: string | null
    csrf: string | null
    origin: string | null
    operation: string | null
    body: unknown
  }[] = []
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === 'POST' ? await request.json() : undefined
      calls.push({
        path,
        cookie: request.headers.get('cookie'),
        csrf: request.headers.get('x-goblin-csrf'),
        origin: request.headers.get('origin'),
        operation: request.headers.get('x-goblin-operation'),
        body,
      })
      if (path.endsWith('/sign-in/email-otp'))
        return Response.json(
          { user: { id: 'fixture-owner' } },
          { headers: { 'set-cookie': 'better-auth.session_token=synthetic-signed-cookie; HttpOnly; Path=/' } },
        )
      if (path.endsWith('/get-session')) return Response.json({ user: { id: 'fixture-owner' } })
      if (path.endsWith('/snapshot')) return Response.json({ type: 'snapshot', entries: [], tools: [], inbox: [] })
      if (path.endsWith('/events'))
        return new Response('event: snapshot\ndata: {"type":"snapshot","entries":[],"tools":[],"inbox":[]}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      if (path.endsWith('/messages'))
        return Response.json({ operationId: 'desktop-operation-01', session: 'fixture-session', accepted: true })
      return Response.json({ ok: true })
    },
  })
  disposers.push(() => upstream.stop(true))
  const origin = `http://127.0.0.1:${upstream.port}`
  const token = crypto.randomUUID()
  const server = startServer({ token, liveOrigin: origin })
  disposers.push(() => server.stop())
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goblin-shell': 'browser' }
  const command = async (body: object) =>
    fetch(`http://127.0.0.1:${server.port}/bridge/command`, { method: 'POST', headers, body: JSON.stringify(body) })
  await command({ type: 'mode', mode: 'live' })
  await command({ type: 'code', email: 'fixture@example.test' })
  const login = await command({ type: 'verify', email: 'fixture@example.test', otp: '123456' })
  const visible = await login.text()
  expect(login.status).toBe(200)
  expect(visible).not.toContain('synthetic-signed-cookie')
  expect(visible).toContain('"signedIn":true')
  await new Promise((resolve) => setTimeout(resolve, 25))
  const sentResponse = await command({ type: 'send', text: 'synthetic message', operationId: 'desktop-operation-01' })
  const sentValue = await sentResponse.json()
  expect(sentValue.error).toBeUndefined()
  expect(sentResponse.status).toBe(200)
  const send = calls.find((call) => call.path.endsWith('/messages'))
  expect(send?.cookie).toBe('better-auth.session_token=synthetic-signed-cookie')
  expect(send?.csrf).toBe('1')
  expect(send?.origin).toBe(origin)
  expect(send?.operation).toBe('desktop-operation-01')
  expect(send?.body).toEqual({ input: 'synthetic message', operationId: 'desktop-operation-01' })
  await command({ type: 'signout' })
  expect((await (await command({ type: 'reconnect' })).json()).error).toBe('Sign in first')
})

test('live SSE projects Pi deltas and uncertain submission keeps one operation id', async () => {
  const { Live } = await import('../live')
  let sends = 0
  const operations: (string | null)[] = []
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith('/sign-in/email-otp'))
        return Response.json(
          { ok: true },
          { headers: { 'set-cookie': 'better-auth.session_token=synthetic; HttpOnly' } },
        )
      if (path.endsWith('/get-session')) return Response.json({ user: { id: 'synthetic' } })
      if (path.endsWith('/snapshot')) return Response.json({ type: 'snapshot', entries: [], tools: [], inbox: [] })
      if (path.endsWith('/events')) {
        const snapshot = { type: 'snapshot', entries: [], tools: [], inbox: [], run: {} }
        const batch = [
          { type: 'message_start', message: { content: [{ type: 'text', text: '' }] } },
          { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Streamed from Pi' }] },
        ]
        return new Response(
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: batch\ndata: ${JSON.stringify(batch)}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (path.endsWith('/messages')) {
        sends++
        operations.push(request.headers.get('x-goblin-operation'))
        if (sends === 1) return new Response('synthetic uncertainty', { status: 503 })
        return Response.json({ operationId: 'uncertain-operation', session: 'synthetic', accepted: false })
      }
      return Response.json({ ok: true })
    },
  })
  disposers.push(() => upstream.stop(true))
  const live = new Live(`http://127.0.0.1:${upstream.port}`, () => {})
  disposers.push(() => live.dispose())
  await live.command({ type: 'verify', email: 'fixture@example.test', otp: '123456' })
  for (let i = 0; i < 100 && !live.view().messages.some((m) => m.text === 'Streamed from Pi'); i++) await delay(5)
  expect(live.view().messages.at(-1)?.text).toBe('Streamed from Pi')
  const send = { type: 'send', text: 'Synthetic only', operationId: 'uncertain-operation' } as const
  await expect(live.command(send)).rejects.toThrow()
  expect(live.view().pendingOperation).toBe('uncertain-operation')
  await expect(live.command({ ...send, operationId: 'different-operation' })).rejects.toThrow(
    'Retry the uncertain message',
  )
  await live.command(send)
  expect(operations).toEqual(['uncertain-operation', 'uncertain-operation'])
  expect(live.view().pendingOperation).toBeUndefined()
})
