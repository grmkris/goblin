import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'
import { streamReadClaims } from '../streams/read-token.ts'
import { streamPath, streamsFetchOf } from '../streams/writer.ts'
import { NotFound, Unauthenticated } from './errors.ts'

/** The reading parameters of the Durable Streams protocol a reader may pass; anything else is dropped. */
const READ_PARAMS = ['offset', 'live', 'cursor'] as const

/**
 * GET or HEAD /streams/<token>: one epoch of a chat's stream in one tier (docs/architecture/streams.md), as the token
 * the join endpoint signed names it. The token is checked (in constant time) before anything is reached, and only the
 * stream object it names is read, with the protocol's reading parameters alone; the agent never wakes. Answers are
 * never cached and carry no CORS headers of the library's. An expired or altered token is `Unauthenticated`
 * (`stream_link`): the reader asks the join endpoint again.
 */
export async function streamRoute(request: Request, env: RuntimeEnv, path: string): Promise<Response> {
  const [, token = ''] = /^\/streams\/([\w.-]{1,4200})$/u.exec(path) ?? []
  const reads = request.method === 'GET' || request.method === 'HEAD'
  if (!reads || token === '' || env.STREAMS === undefined) throw new NotFound({ what: 'route' })
  const claims = await streamReadClaims(env.CREDENTIAL_KEY, token, nowSeconds())
  if (claims === undefined) throw new Unauthenticated({ reason: 'stream_link' })
  const from = new URL(request.url)
  const target = new URL(
    `https://streams.internal${streamPath(claims.workspaceId, claims.chat, claims.tier, claims.epoch)}`,
  )
  for (const name of READ_PARAMS) {
    const value = from.searchParams.get(name)
    if (value !== null) target.searchParams.set(name, value)
  }
  const tag = request.headers.get('if-none-match')
  const response = await streamsFetchOf(env.STREAMS)(
    new Request(target, { method: request.method, headers: tag === null ? {} : { 'if-none-match': tag } }),
  )
  const headers = new Headers(response.headers)
  const names = Array.from(headers.keys())
  for (const name of names) if (name.startsWith('access-control-')) headers.delete(name)
  headers.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
