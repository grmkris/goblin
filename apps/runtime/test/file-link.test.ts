import { InternalApi } from '@goblin/contracts/internal'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as TestClock from 'effect/testing/TestClock'
import { ChatOperations, Chats, Conversations } from '../src/chats/service.ts'
import type { RuntimeEnv } from '../src/env.ts'
import { fileLink } from '../src/files/link.ts'
import { FILE_LINK_SECONDS, fileLinkClaims, fileLinkToken } from '../src/files/link-token.ts'
import { Files } from '../src/files/service.ts'
import { NotFound, ResidentInactive } from '../src/http/errors.ts'
import { routeNames } from '../src/http/api/context.ts'
import { InternalGateLive } from '../src/http/api/middleware.ts'
import { AgentHttp } from '../src/http/api/server.ts'
import { worker } from '../src/http/worker.ts'
import { InboundHandlers } from '../src/inbound/api.ts'
import { Inspection } from '../src/inspect/service.ts'
import { eventsHookToken } from '../src/mcp/events/route-token.ts'
import { Events, Resident } from '../src/mcp/service.ts'
import { Notices } from '../src/notices/service.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Changes } from '../src/runtime/changes.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { fake } from './fake.ts'
import { serve, stub } from './http/api/fixture.ts'

/** 32 bytes, base64, as CREDENTIAL_KEY is; and another deployment's. */
const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const OTHER_KEY = 'b3RoZXItZGVwbG95bWVudC1rZXktLS0tLS0tLS0tLS0='
const APP = 'https://goblin.test'
const NOW = 1_800_000_000
const PHOTO = {
  path: '/uploads/2026-10-15/photo.png',
  name: 'photo.png',
  kind: 'file' as const,
  size: 4,
  mimeType: 'image/png',
  updatedAt: 1,
}

const claims = (expiresAt = NOW + FILE_LINK_SECONDS) => ({ workspaceId: 'user-1', path: PHOTO.path, expiresAt })

/** `token` with the character at `index` changed. */
const flipped = (token: string, index: number): string =>
  `${token.slice(0, index)}${token[index] === 'A' ? 'B' : 'A'}${token.slice(index + 1)}`

describe('a file link token (ADR 0070)', () => {
  it('says whose file and which until it expires, and nothing past fifteen minutes', async () => {
    const token = await fileLinkToken(KEY, claims())
    expect(await fileLinkClaims(KEY, token, NOW)).toEqual(claims())
    expect(await fileLinkClaims(KEY, token, NOW + FILE_LINK_SECONDS - 1)).toEqual(claims())
    expect(await fileLinkClaims(KEY, token, NOW + FILE_LINK_SECONDS)).toBeUndefined()
    // A link signed to last longer than fifteen minutes is refused, whoever made it.
    const long = await fileLinkToken(KEY, claims(NOW + FILE_LINK_SECONDS + 1))
    expect(await fileLinkClaims(KEY, long, NOW)).toBeUndefined()
  })

  it('refuses a token changed anywhere, signed with another key, or made for another purpose', async () => {
    const token = await fileLinkToken(KEY, claims())
    const dot = token.indexOf('.')
    expect(await fileLinkClaims(KEY, flipped(token, 2), NOW)).toBeUndefined()
    expect(await fileLinkClaims(KEY, flipped(token, dot + 3), NOW)).toBeUndefined()
    expect(await fileLinkClaims(KEY, `${token.slice(0, dot)}.${token.slice(0, 43)}`, NOW)).toBeUndefined()
    expect(await fileLinkClaims(OTHER_KEY, token, NOW)).toBeUndefined()
    const hook = await eventsHookToken(KEY, 'user-1', 'chat')
    expect(await fileLinkClaims(KEY, `${token.slice(0, dot)}.${hook}`, NOW)).toBeUndefined()
    expect(await fileLinkClaims(KEY, 'not a token', NOW)).toBeUndefined()
  })
})

/** The agent's inputs a link reads: the deployment's key and URL, and whose agent it is. */
const inputs = Layer.succeed(
  AgentInput,
  fake<AgentInputs>({ env: fake<RuntimeEnv>({ CREDENTIAL_KEY: KEY, APP_URL: `${APP}/` }), workspaceId: 'user-1' }),
)
const resident = (current: boolean) =>
  stub(Resident, { require: () => (current ? Effect.void : Effect.fail(new ResidentInactive({ state: 'revoked' }))) })

describe('file_link (ADR 0070)', () => {
  it.effect(
    "answers a link on goblin's own origin to that file, for fifteen minutes, with its name, type and size",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW * 1000)
        const files = stub(Files, { stat: (path) => Effect.succeed({ ...PHOTO, path }) })
        const answer = yield* fileLink(PHOTO.path).pipe(Effect.provide(Layer.mergeAll(files, inputs, resident(true))))
        expect(answer).toMatchObject({
          expiresAt: new Date((NOW + FILE_LINK_SECONDS) * 1000).toISOString(),
          name: 'photo.png',
          mimeType: 'image/png',
          size: 4,
        })
        const [, token = ''] = /^https:\/\/goblin\.test\/files\/link\/([\w.-]+)\/photo\.png$/u.exec(answer.url) ?? []
        expect(yield* Effect.promise(() => fileLinkClaims(KEY, token, NOW))).toEqual(claims())
      }),
  )

  it.effect('needs current resident authority, and a file that is there', () =>
    Effect.gen(function* () {
      const gone = stub(Files, { stat: (path) => Effect.fail(new NotFound({ what: path })) })
      const lapsed = yield* Effect.flip(
        fileLink(PHOTO.path).pipe(Effect.provide(Layer.mergeAll(gone, inputs, resident(false)))),
      )
      expect(lapsed).toBeInstanceOf(ResidentInactive)
      const missing = yield* Effect.flip(
        fileLink(PHOTO.path).pipe(Effect.provide(Layer.mergeAll(gone, inputs, resident(true)))),
      )
      expect(missing).toBeInstanceOf(NotFound)
    }),
  )
})

/** The bytes of the photo every agent below holds. */
const BYTES = new Uint8Array([137, 80, 78, 71])

/**
 * One user's agent, as its internal API answers the Worker: the real inbound handlers over a Files service that holds
 * the photo, with resident authority `current`; `asked` records each path it was asked to read.
 */
const agent = (current = true) => {
  const asked: string[] = []
  const files = stub(Files, {
    read: (path) =>
      Effect.sync(() => {
        asked.push(path)
        return { entry: { ...PHOTO, path }, body: new Response(BYTES).body ?? new ReadableStream() }
      }),
  })
  const http = AgentHttp.serve(
    [routeNames(InternalApi)],
    HttpApiBuilder.layer(InternalApi).pipe(
      Layer.provide(InboundHandlers),
      Layer.provide(InternalGateLive),
      Layer.provide(HttpServer.layerServices),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        files,
        resident(current),
        stub(Events),
        stub(Inspection),
        stub(Chats),
        stub(ChatOperations),
        stub(PiSessions),
        stub(AgentInput),
        stub(Conversations),
        stub(Notices),
        stub(Changes),
      ),
    ),
  )
  return { ...serve(http), asked }
}

/** The deployment, its agents by user id; `woken` records each agent the Worker asked for. */
const deployment = (agents: Readonly<Record<string, ReturnType<typeof agent>>>) => {
  const woken: string[] = []
  const env = fake<RuntimeEnv>({
    APP_URL: APP,
    CREDENTIAL_KEY: KEY,
    AGENTS: fake<RuntimeEnv['AGENTS']>({
      getByName: (name: string) => {
        woken.push(name)
        const found = agents[name]
        if (found === undefined) throw new Error(`no agent ${name}`)
        return fake<ReturnType<RuntimeEnv['AGENTS']['getByName']>>({
          fetch: (input: RequestInfo | URL, init?: RequestInit) => found.fetch(new Request(input, init)),
        })
      },
    }),
  })
  return { env, woken }
}

const linkTo = async (expiresAt: number, user = 'user-1') =>
  `${APP}/files/link/${await fileLinkToken(KEY, { workspaceId: user, path: PHOTO.path, expiresAt })}/photo.png`

const now = () => Math.floor(Date.now() / 1000)

describe('the file link route (ADR 0070)', () => {
  it("serves the token's user's file, as an attachment of its type, never cached and with no cookie", async () => {
    const owner = agent()
    const other = agent()
    const { env, woken } = deployment({ 'user-1': owner, 'user-2': other })
    const response = await worker.fetch(new Request(await linkTo(now() + 60)), env)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''photo.png")
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(woken).toEqual(['user-1'])
    expect(owner.asked).toEqual([PHOTO.path])
    expect(other.asked).toEqual([])
  })

  it('answers a bad, expired or tampered token, or anything but GET, with the 404 envelope, waking no agent', async () => {
    const { env, woken } = deployment({ 'user-1': agent() })
    const live = await linkTo(now() + 60)
    const token = live.slice(`${APP}/files/link/`.length, live.lastIndexOf('/'))
    for (const request of [
      new Request(await linkTo(now() - 1)),
      new Request(`${APP}/files/link/${flipped(token, 5)}/photo.png`),
      new Request(`${APP}/files/link/${token.slice(0, -1)}`),
      new Request(`${APP}/files/link/nothing`),
      new Request(live, { method: 'POST', body: '{}' }),
      new Request(live, { method: 'HEAD' }),
    ]) {
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(404)
      if (request.method !== 'HEAD')
        expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    }
    expect(woken).toEqual([])
  })

  it('answers 404 when the agent will not serve it: resident authority lapsed', async () => {
    const lapsed = agent(false)
    const { env } = deployment({ 'user-1': lapsed })
    const response = await worker.fetch(new Request(await linkTo(now() + 60)), env)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'file' } })
    expect(lapsed.asked).toEqual([])
  })
})
