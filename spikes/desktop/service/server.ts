import { timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { Fixture } from './fixture'
import { Live } from './live'
import { hosts, type Command, type HostName } from '../shared/src/types'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function commandOf(value: unknown): Command {
  if (!record(value)) throw new Error('Invalid command')
  const type = value.type
  const str = (key: string, max: number): string => {
    const v = value[key]
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`Invalid ${key}`)
    return v
  }
  if (type === 'send') {
    const operationId = str('operationId', 100)
    if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error('Invalid operationId')
    return { type, text: str('text', 20000), operationId }
  }
  if (type === 'select') return { type, id: str('id', 100) }
  if (type === 'mode' && (value.mode === 'fixture' || value.mode === 'live')) return { type, mode: value.mode }
  if (type === 'code' || type === 'verify') {
    const email = str('email', 254)
    const invite = typeof value.invite === 'string' ? value.invite.slice(0, 200) : ''
    return type === 'code' ? { type, email, invite } : { type, email, invite, otp: str('otp', 32) }
  }
  if (type === 'new' || type === 'stop' || type === 'history' || type === 'reconnect' || type === 'signout')
    return { type }
  throw new Error('Unknown command')
}

export function startServer(options: {
  port?: number
  token: string
  dist?: string
  liveOrigin?: string
  fetch?: typeof fetch
}) {
  const profiles = new Map<HostName, { fixture: Fixture; live: Live; mode: 'fixture' | 'live'; busy: boolean }>()
  const listeners = new Map<HostName, Set<(data: string) => void>>()
  const view = (host: HostName) => {
    const p = profiles.get(host)
    if (!p) throw new Error('Unknown profile')
    return p.mode === 'fixture' ? p.fixture.view() : p.live.view()
  }
  for (const host of hosts) {
    listeners.set(host, new Set())
    const publish = () => {
      for (const send of listeners.get(host) ?? []) send(`data: ${JSON.stringify(view(host))}\n\n`)
    }
    profiles.set(host, {
      fixture: new Fixture(publish),
      live: new Live(options.liveOrigin ?? 'https://dev.goblin.surf', publish, options.fetch),
      mode: 'fixture',
      busy: false,
    })
  }
  const root = resolve(options.dist ?? new URL('../dist', import.meta.url).pathname)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    maxRequestBodySize: 40000,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = `http://127.0.0.1:${server.port}`
      if (url.origin !== origin || (request.headers.has('origin') && request.headers.get('origin') !== origin))
        return new Response('Forbidden origin', { status: 403 })
      if (!url.pathname.startsWith('/bridge/')) {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        const file = url.pathname === '/' ? resolve(root, 'index.html') : resolve(root, `.${url.pathname}`)
        if (!file.startsWith(`${root}/`) || !(await Bun.file(file).exists()))
          return new Response('Not found', { status: 404 })
        return new Response(Bun.file(file), {
          headers: {
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          },
        })
      }
      const credential = request.headers.get('authorization') ?? ''
      const expected = `Bearer ${options.token}`
      if (credential.length !== expected.length || !timingSafeEqual(Buffer.from(credential), Buffer.from(expected)))
        return new Response('Unauthorized', { status: 401 })
      const host = hosts.find((item) => item === request.headers.get('x-goblin-shell'))
      const profile = host ? profiles.get(host) : undefined
      if (!profile || !host) return new Response('Unknown shell', { status: 400 })
      if (url.pathname === '/bridge/state' && request.method === 'GET')
        return Response.json(view(host), { headers: { 'cache-control': 'no-store' } })
      if (url.pathname === '/bridge/events' && request.method === 'GET') {
        const encoder = new TextEncoder()
        let remove = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: string) => {
              if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(value))
            }
            const clients = listeners.get(host)
            clients?.add(send)
            const heartbeat = setInterval(() => send(': keepalive\n\n'), 15000)
            remove = () => {
              clearInterval(heartbeat)
              clients?.delete(send)
            }
            send(`data: ${JSON.stringify(view(host))}\n\n`)
          },
          cancel() {
            remove()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
      }
      if (url.pathname !== '/bridge/command' || request.method !== 'POST') return new Response(null, { status: 404 })
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return new Response(null, { status: 415 })
      if (profile.busy) return new Response('A command is already in progress', { status: 409 })
      profile.busy = true
      try {
        const command = commandOf(await request.json())
        if (command.type === 'mode') {
          if (profile.live.view().pendingOperation)
            throw new Error('Retry the uncertain message or sign out before changing mode')
          profile.fixture.dispose()
          profile.live.dispose()
          profile.mode = command.mode
          if (profile.mode === 'live' && profile.live.view().signedIn) await profile.live.command({ type: 'reconnect' })
        } else if (profile.mode === 'fixture') profile.fixture.command(command)
        else await profile.live.command(command)
        return Response.json(view(host), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 })
      } finally {
        profile.busy = false
      }
    },
    error() {
      return new Response('Companion request failed', { status: 500 })
    },
  })
  return {
    port: server.port,
    stop() {
      for (const p of profiles.values()) {
        p.fixture.dispose()
        p.live.dispose()
      }
      server.stop(true)
    },
  }
}
