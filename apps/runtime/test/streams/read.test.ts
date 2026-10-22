// Who reads which tier of a chat's stream, and the token of the URL they read it at: signed for its workspace, chat,
// tier and epoch, for ten minutes, and good for nothing else (docs/architecture/streams.md).
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { fileLinkClaims } from '../../src/files/link-token.ts'
import { RequestContext, type RequestFacts } from '../../src/http/api/context.ts'
import type { Caller } from '../../src/http/api/principal.ts'
import { worker } from '../../src/http/worker.ts'
import { requestTier } from '../../src/keys/policy.ts'
import { STREAM_READ_SECONDS, streamReadClaims, streamReadToken } from '../../src/streams/read-token.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { fake } from '../fake.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const OTHER_KEY = 'b3RoZXItZGVwbG95bWVudC1rZXktLS0tLS0tLS0tLS0='
const NOW = 1_800_000_000
const claims = (expiresAt = NOW + STREAM_READ_SECONDS) =>
  ({ workspaceId: 'ws-1', chat: '7', tier: 'answers', epoch: 2, expiresAt }) as const

/** The tier a request of `caller` reads; a member's session has none. */
const tierOf = (caller?: Caller) => {
  const facts: RequestFacts = {
    ref: undefined,
    request: undefined,
    operation: undefined,
    route: 'conversations.stream',
  }
  return Effect.runSync(
    requestTier.pipe(Effect.provideService(RequestContext, caller === undefined ? facts : { ...facts, caller })),
  )
}

describe('the tier a request reads', () => {
  it('is full for a session and a client holding transcripts, answers for a key and any other client', () => {
    expect(tierOf()).toBe('full')
    const client = { kind: 'client', clientId: 'c-1', name: 'Viewer' } as const
    expect(tierOf({ ...client, scopes: ['conversations', 'transcripts'] })).toBe('full')
    expect(tierOf({ ...client, scopes: ['conversations'] })).toBe('answers')
    expect(
      tierOf({ kind: 'key', keyId: 'k-1', name: 'shop', scopes: ['conversations'], servers: [], origins: [] }),
    ).toBe('answers')
  })
})

describe('a stream URL token', () => {
  it('says which stream until it expires, and nothing past ten minutes', async () => {
    const token = await streamReadToken(KEY, claims())
    expect(await streamReadClaims(KEY, token, NOW)).toEqual(claims())
    expect(await streamReadClaims(KEY, token, NOW + STREAM_READ_SECONDS)).toBeUndefined()
    expect(await streamReadClaims(KEY, await streamReadToken(KEY, claims(NOW + 601)), NOW)).toBeUndefined()
  })

  it('is refused altered, under another key, or as a file link', async () => {
    const token = await streamReadToken(KEY, claims())
    const altered = `${token.slice(0, 3)}${token[3] === 'A' ? 'B' : 'A'}${token.slice(4)}`
    expect(await streamReadClaims(KEY, altered, NOW)).toBeUndefined()
    expect(await streamReadClaims(OTHER_KEY, token, NOW)).toBeUndefined()
    expect(await fileLinkClaims(KEY, token, NOW)).toBeUndefined()
    expect(await streamReadClaims(KEY, 'not a token', NOW)).toBeUndefined()
  })

  it.effect('opens nothing at the Worker but GET and HEAD with a token goblin signed', () =>
    Effect.gen(function* () {
      const reached: string[] = []
      const streams = fake<DurableObjectNamespace>({
        idFromName: (name: string) => fake<DurableObjectId>({ toString: () => name }),
        get: (id: DurableObjectId) =>
          fake<DurableObjectStub>({
            fetch: async (request: Request) => {
              reached.push(`${request.method} ${String(id)} ${new URL(request.url).search}`)
              return new Response('[]', {
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' },
              })
            },
          }),
      })
      const env = fake<RuntimeEnv>({ APP_URL: 'https://goblin.test', CREDENTIAL_KEY: KEY, STREAMS: streams })
      const expiresAt = Math.floor(Date.now() / 1000) + STREAM_READ_SECONDS
      const token = yield* Effect.promise(() => streamReadToken(KEY, claims(expiresAt)))
      const read = (method: string, path: string) =>
        Effect.promise(() => worker.fetch(new Request(`https://goblin.test${path}`, { method }), env))
      const answer = yield* read('GET', `/streams/${token}?offset=-1&live=long-poll&other=1`)
      expect(answer.status).toBe(200)
      expect(answer.headers.get('cache-control')).toBe('no-store')
      expect(answer.headers.get('access-control-allow-origin')).toBeNull()
      expect((yield* read('HEAD', `/streams/${token}`)).status).toBe(200)
      expect(reached).toEqual(['GET /s/ws-1/7/answers/2 ?offset=-1&live=long-poll', 'HEAD /s/ws-1/7/answers/2 '])
      expect((yield* read('POST', `/streams/${token}`)).status).toBe(404)
      expect((yield* read('GET', '/streams/not.a-token')).status).toBe(401)
      expect(reached).toHaveLength(2)
    }),
  )
})
