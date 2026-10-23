import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Credential } from '../../src/http/api/principal.ts'
import { ownerCall } from '../../src/inbound/client.ts'
import { type CallerReach, mcpServer } from '../../src/inbound/mcp-server.ts'
import { credential } from '../grants-fixture.ts'

const KEY = credential({ id: 'key-1', name: 'swarmm', level: 'read' })
const SUBSCRIBED = {
  id: 'sub_1',
  refreshBefore: '2026-10-22T12:00:00.000Z',
  cursor: '0000000000000004',
  truncated: false,
  deliveryStatus: { active: true, lastError: null },
}

/** /mcp for `caller` over an agent that records each request and answers `reply`. */
const handlerFor = (caller: Credential, reply: (request: Request) => Response, reach?: CallerReach) => {
  const seen: Request[] = []
  const agent = {
    fetch: async (request: Request) => {
      seen.push(request.clone())
      return reply(request)
    },
  }
  const member =
    caller.kind === 'client' ? { user: 'u1', role: 'owner' as const, name: 'Owner', shared: false } : undefined
  const handler = createMcpHandler(() =>
    mcpServer(caller, (call) => Effect.runPromise(ownerCall(agent, caller, member, call)), reach),
  )
  return { handler, seen }
}

/** A client of `handler`, on the 2026 revision (`server/discover`) when `modern`, and the discovery it read. */
const connected = async (handler: ReturnType<typeof handlerFor>['handler'], modern = false) => {
  const raw: string[] = []
  const client = new Client(
    { name: 'probe', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000, maxRetries: 0 } } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp'), {
      fetch: async (input, init) => {
        const response = await handler.fetch(new Request(input, init))
        if (typeof init?.body === 'string' && /"method":"(?:initialize|server\/discover)"/u.test(init.body))
          raw.push(await response.clone().text())
        return response
      },
    }),
  )
  return { client, raw }
}

const Anything = Schema.toStandardSchemaV1(Schema.Unknown)

/** An agent that refuses with `error` in the envelope. */
const refusal = (status: number, error: Record<string, unknown>) => () => Response.json({ error }, { status })

describe('/mcp publishes Events (ADR 0112)', () => {
  it('declares capabilities.events and the extension on the wire, only for a caller holding conversations', async () => {
    const { handler } = handlerFor(KEY, () => Response.json({}))
    const { client, raw } = await connected(handler)
    // The SDK's client strips the draft top-level capability; its own answer on the wire keeps it.
    expect(raw.join('')).toContain('"events":{}')
    expect(raw.join('')).toContain('"io.modelcontextprotocol/events":{}')
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(['io.modelcontextprotocol/events'])
    expect(client.getInstructions()).toContain('events/subscribe')
    await client.close()
    const legacy = await handler.fetch(
      new Request('https://goblin.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '1' } },
        }),
      }),
    )
    expect(await legacy.text()).toContain('"events":{}')
  })

  it('calls the events endpoints as the caller, with a client’s workspace taken out of the arguments', async () => {
    const reach: CallerReach = {
      all: false,
      named: true,
      workspaces: [
        { id: 'ws-a', slug: 'swarmm', name: 'Swarmm', role: 'owner', members: 1 },
        { id: 'ws-b', slug: 'side', name: 'Side', role: 'owner', members: 1 },
      ],
    }
    const client = credential({ kind: 'client', id: 'cc', name: 'Claude Code', grantId: 'cg_1', level: 'read' })
    const { handler, seen } = handlerFor(client, () => Response.json(SUBSCRIBED), reach)
    const { client: mcp } = await connected(handler)
    const delivery = { mode: 'webhook', url: 'https://hooks.example.com/a', secret: 'whsec_x' }
    const answer = await mcp.request(
      {
        method: 'events/subscribe',
        params: { name: 'conversation.updated', arguments: { topic: '2', workspace: 'side' }, delivery },
      },
      Anything,
    )
    expect(answer).toMatchObject(SUBSCRIBED)
    const [request] = seen
    expect(new URL(request?.url ?? '').pathname).toBe('/api/events/subscribe')
    expect(await request?.json()).toEqual({ name: 'conversation.updated', arguments: { topic: '2' }, delivery })
    expect(JSON.parse(request?.headers.get('x-goblin-caller') ?? '{}')).toMatchObject({ kind: 'client', id: 'cc' })
    await mcp.close()
  })

  it('answers the profile’s error codes, and events/stream is unsupported', async () => {
    const cases = [
      [refusal(404, { code: 'not_found', message: 'x', what: 'subscription' }), -32011],
      [refusal(400, { code: 'invalid_input', message: 'x', reason: 'event_callback_url' }), -32602],
      [refusal(409, { code: 'conflict', message: 'x', reason: 'event_callback' }), -32015],
      [refusal(409, { code: 'conflict', message: 'x', reason: 'event_subscriptions' }), -32013],
    ] as const
    for (const [reply, code] of cases) {
      const { handler } = handlerFor(KEY, reply)
      const { client } = await connected(handler)
      await expect(
        client.request(
          {
            method: 'events/unsubscribe',
            params: { name: 'conversation.updated', delivery: { mode: 'webhook', url: 'https://hooks.example.com/a' } },
          },
          Anything,
        ),
      ).rejects.toMatchObject({ code })
      await client.close()
    }
    const { handler } = handlerFor(KEY, () => Response.json({}))
    const { client } = await connected(handler)
    await expect(
      client.request({ method: 'events/stream', params: { name: 'conversation.updated', arguments: {} } }, Anything),
    ).rejects.toMatchObject({ code: -32014 })
    await expect(client.request({ method: 'events/poll', params: { name: 7 } }, Anything)).rejects.toMatchObject({
      code: -32602,
    })
    await client.close()
  })
})
