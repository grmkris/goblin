import { timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { hosts, type HostName } from '../shared/src/types'
import { commandOf } from './commands'
import { Profiles } from './profiles'

type Options = { port?: number; token: string; dist?: string; liveOrigin?: string; fetch?: typeof fetch }
const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } })
function authenticate(request: Request, token: string): HostName | Response {
  const supplied = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return new Response('Unauthorized', { status: 401 })
  return (
    hosts.find((host) => host === request.headers.get('x-goblin-shell')) ??
    new Response('Unknown shell', { status: 400 })
  )
}
async function staticFile(request: Request, root: string, pathname: string): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  const file = pathname === '/' ? resolve(root, 'index.html') : resolve(root, `.${pathname}`)
  if (!file.startsWith(`${root}/`) || !(await Bun.file(file).exists()))
    return new Response('Not found', { status: 404 })
  return new Response(Bun.file(file), {
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
  })
}
async function bridge(request: Request, pathname: string, host: HostName, profiles: Profiles): Promise<Response> {
  if (pathname === '/bridge/state' && request.method === 'GET') return json(profiles.view(host))
  if (pathname === '/bridge/events' && request.method === 'GET') return profiles.events(host)
  if (pathname !== '/bridge/command' || request.method !== 'POST') return new Response(null, { status: 404 })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 })
  try {
    return json(await profiles.command(host, commandOf(await request.json())))
  } catch (error) {
    // expected: command validation/refusals are returned to the local client without logging content.
    return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 })
  }
}
export function startServer(options: Options) {
  const profiles = new Profiles(options.liveOrigin ?? 'https://dev.goblin.surf', options.fetch)
  const root = resolve(options.dist ?? new URL('../dist', import.meta.url).pathname)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    maxRequestBodySize: 40000,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = `http://127.0.0.1:${server.port}`
      const source = request.headers.get('origin')
      if (url.origin !== origin || (source !== null && source !== origin))
        return new Response('Forbidden origin', { status: 403 })
      if (!url.pathname.startsWith('/bridge/')) return staticFile(request, root, url.pathname)
      const host = authenticate(request, options.token)
      if (host instanceof Response) return host
      return bridge(request, url.pathname, host, profiles)
    },
    error() {
      return new Response('Companion request failed', { status: 500 })
    },
  })
  return {
    port: server.port,
    async stop() {
      profiles.dispose()
      await server.stop(true)
    },
  }
}
