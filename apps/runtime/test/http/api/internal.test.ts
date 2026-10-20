import { OwnerApi, ResidentGroup } from '@goblin/contracts/api'
import { InternalApi } from '@goblin/contracts/internal'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { describe, expect, it } from 'vitest'
import { ChatOperations, Chats, Conversations } from '../../../src/chats/service.ts'
import { Files } from '../../../src/files/service.ts'
import { routeNames } from '../../../src/http/api/context.ts'
import { InternalGateLive } from '../../../src/http/api/middleware.ts'
import { AgentHttp } from '../../../src/http/api/server.ts'
import { InboundHandlers } from '../../../src/inbound/api.ts'
import { Events, Resident } from '../../../src/mcp/service.ts'
import { Notices } from '../../../src/notices/service.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { Changes } from '../../../src/runtime/changes.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { currentResident, get, post, serve, served, stub, unrouted } from './fixture.ts'

/** The internal API as the agent serves it, behind the internal gate, over `handlers`. */
const servedInternal = <Handlers, R>(handlers: Layer.Layer<Handlers, never, R>) =>
  AgentHttp.serve(
    [routeNames(InternalApi)],
    HttpApiBuilder.layer(InternalApi).pipe(
      Layer.provide(handlers),
      Layer.provide(InternalGateLive),
      Layer.provide(HttpServer.layerServices),
    ),
  )

/** Handlers that only record which endpoint ran, so the gate is what the test sees. */
const recording = () => {
  const ran: string[] = []
  const mark = <A>(name: string, value: A) =>
    Effect.sync(() => {
      ran.push(name)
      return value
    })
  const handlers = HttpApiBuilder.group(InternalApi, 'inbound', (group) =>
    group
      .handle('mcpEvents', () => mark('mcpEvents', { status: 204 as const }))
      .handleRaw('linkedFile', () => mark('linkedFile', HttpServerResponse.text('bytes'))),
  )
  return { ran, handlers }
}

/** The real handlers over stubs: only the services a case names do anything. */
const fixture = (parts: { readonly events?: Layer.Layer<Events> }) =>
  serve(
    servedInternal(InboundHandlers).pipe(
      Layer.provide(
        Layer.mergeAll(
          parts.events ?? stub(Events),
          stub(Chats),
          stub(ChatOperations),
          stub(PiSessions),
          stub(AgentInput),
          stub(Conversations),
          stub(Notices),
          stub(Changes),
          stub(Files),
          Layer.succeed(Resident, currentResident().service),
        ),
      ),
    ),
  )

const internal = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  body === undefined ? get(`/internal${path}`, headers) : post(`/internal${path}`, body, headers)

describe('the internal API served by the agent', () => {
  it('answers a request without the owner mark', async () => {
    const { ran, handlers } = recording()
    const { fetch } = serve(servedInternal(handlers))
    const linked = await fetch(
      internal('/files/linked?path=%2Fuploads%2Fnotes.md', undefined, { 'x-goblin-ref': 'ray-1' }),
    )
    expect(linked.status).toBe(200)
    expect(await linked.text()).toBe('bytes')
    expect(ran).toEqual(['linkedFile'])
  })

  it('refuses a request marked as the owner forward with the 404 envelope, before any handler runs', async () => {
    const { ran, handlers } = recording()
    const { fetch } = serve(servedInternal(handlers))
    for (const request of [
      internal('/files/linked?path=%2Fuploads%2Fnotes.md', undefined, {
        'x-goblin-forwarded': 'owner',
        'x-goblin-ref': 'ray-2',
      }),
      internal('/files/linked?path=%2Fuploads%2Fnotes.md', undefined, { 'x-goblin-forwarded': '' }),
      // What /mcp's callers once asked here is the owner API's now (ADR 0086).
      internal('/ask', { input: 'hello', operationId: 'op-1', waitMs: 0 }),
      internal('/nothing-here', {}),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    }
    expect(ran).toEqual([])
  })

  it('serves only its own prefix, and the owner API only its own', async () => {
    const { handlers } = recording()
    const internalOnly = serve(servedInternal(handlers))
    expect(await unrouted(await internalOnly.fetch(get('/api/agent/resident')))).toBe(true)
    const resident = currentResident()
    const ownerOnly = serve(
      served([ResidentGroup], ResidentHandlers).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Resident, resident.service), stub(Events))),
      ),
    )
    const refused = await ownerOnly.fetch(internal('/files/linked?path=%2Fuploads%2Fnotes.md'))
    expect(refused.status).toBe(404)
    const ownerRoute = routeNames(OwnerApi)
    const internalRoute = routeNames(InternalApi)
    expect(ownerRoute(internal('/files/linked?path=%2Fuploads%2Fnotes.md'))).toBeUndefined()
    expect(internalRoute(get('/api/agent/resident'))).toBeUndefined()
    expect(internalRoute(get('/files/linked?path=%2Fuploads%2Fnotes.md'))).toBeUndefined()
  })
})

describe('the inbound handlers', () => {
  it("hands a connection's Events webhook bytes and signing headers to ingress, and answers its result", async () => {
    const seen: unknown[] = []
    const events = stub(Events, {
      receive: (input) =>
        Effect.sync(() => {
          seen.push(input)
          return { status: 200 as const, response: '{"ok":1}' }
        }),
    })
    const { fetch } = fixture({ events })
    const response = await fetch(
      new Request('https://agent/internal/mcp-events/sidequest-hirer', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-mcp-subscription-id': 'sub-1',
          'webhook-id': 'evt-1',
          'webhook-timestamp': '17',
          'webhook-signature': 'v1,sig',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(await response.json()).toEqual({ status: 200, response: '{"ok":1}' })
    expect(seen).toEqual([
      {
        connectionId: 'sidequest-hirer',
        body: new Uint8Array([1, 2, 3]),
        subscriptionId: 'sub-1',
        id: 'evt-1',
        timestamp: '17',
        signature: 'v1,sig',
      },
    ])
  })
})
