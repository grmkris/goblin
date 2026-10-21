import type { CallerScope } from '@goblin/contracts'
import { BudgetExhausted, OwnerApi, envelopeOf } from '@goblin/contracts/api'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { callerScopesOf } from '../../src/auth/resources.ts'
import { endpointScopes } from '../../src/http/api/context.ts'
import type { Caller } from '../../src/http/api/principal.ts'
import { ownerCall } from '../../src/inbound/client.ts'
import { mcpServer } from '../../src/inbound/mcp-server.ts'
import { TOOLS } from '../../src/inbound/tools.ts'

const KEY: Caller = {
  kind: 'key',
  keyId: 'key-1',
  scopes: ['topics', 'conversations', 'personas'],
  servers: ['mycut'],
  origins: [],
}
/** An OAuth client the owner consented to with `scopes` (ADR 0086). */
const client = (scopes: readonly string[]): Caller => ({
  kind: 'client',
  clientId: 'claude-code',
  name: 'Claude Code',
  scopes: callerScopesOf(scopes),
})

/** /mcp for `caller` over an agent that records what reached it and answers `reply`. */
const connect = async (caller: Caller, reply: (request: Request) => Response = () => Response.json({})) => {
  const seen: Request[] = []
  const agent = {
    fetch: async (request: Request) => {
      seen.push(request.clone())
      return reply(request)
    },
  }
  const handler = createMcpHandler(() =>
    mcpServer(caller.scopes, (call) =>
      Effect.runPromise(
        ownerCall(
          agent,
          caller,
          caller.kind === 'client' ? { user: 'owner', role: 'owner', name: 'Owner', shared: false } : undefined,
          call,
          { ref: 'ref-edge' },
        ),
      ),
    ),
  )
  const mcp = new Client({ name: 'probe', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp'), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    }),
  )
  return { mcp, seen }
}

const listed = async (caller: Caller) => {
  const { mcp } = await connect(caller)
  try {
    return (await mcp.listTools()).tools.map((tool) => tool.name).toSorted()
  } finally {
    await mcp.close()
  }
}

/** The tools whose endpoints a caller holding `scopes` reaches. */
const toolsFor = (scopes: readonly CallerScope[]) => {
  const scopeOf = endpointScopes(OwnerApi)
  return Object.entries(TOOLS)
    .filter(([, endpoint]) => scopes.some((scope) => scope === scopeOf.get(endpoint)))
    .map(([name]) => name)
    .toSorted()
}
const textOf = (result: { readonly content?: unknown }): unknown =>
  // SAFETY: every goblin tool answers one text block (`text` and `failed` in inbound/tools.ts).
  JSON.parse((result.content as readonly { readonly text: string }[])[0]?.text ?? 'null')

describe('/mcp for every caller (ADR 0086)', () => {
  it('has exactly one tool for each owner endpoint a caller reaches', () => {
    expect(Object.values(TOOLS).toSorted()).toEqual([...endpointScopes(OwnerApi).keys()].toSorted())
  })

  it('lists only what a consent grants: asking alone, then inspection, then everything', async () => {
    expect(await listed(client([]))).toEqual(['ask_agent', 'get_recent_messages'])
    expect(await listed(client(['goblin:inspect']))).toEqual(toolsFor(['agent', 'inspect', 'transcripts']))
    expect(await listed(client(['goblin:inspect']))).toContain('inspect_conversation')
    const all = client(['goblin:topics', 'goblin:conversations', 'goblin:personas', 'goblin:inspect'])
    expect(await listed(all)).toEqual(Object.keys(TOOLS).toSorted())
  })

  it("lists a key's tools by its scopes, never asking the agent or reading conversations in full", async () => {
    const tools = await listed(KEY)
    expect(tools).toEqual(toolsFor(KEY.scopes))
    expect(tools).not.toContain('ask_agent')
    const inspecting = await listed({ ...KEY, scopes: [...KEY.scopes, 'inspect'] })
    expect(inspecting).toContain('inspect_turn')
    expect(inspecting).not.toContain('inspect_conversation')
    expect(inspecting).not.toContain('inspect_conversations')
  })

  it('calls the owner API as the caller: an owner forward carrying it, never a credential', async () => {
    const page = { personas: [] }
    for (const caller of [KEY, client(['goblin:personas'])]) {
      const { mcp, seen } = await connect(caller, () => Response.json(page))
      try {
        const result = await mcp.callTool({ name: 'persona_list', arguments: { name: 'edit', limit: 10 } })
        expect(textOf(result)).toEqual(page)
        expect(result.structuredContent).toEqual(page)
        const [request] = seen
        const url = new URL(request?.url ?? '')
        expect(url.pathname).toBe('/api/personas')
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '10', name: 'edit' })
        expect(request?.headers.get('x-goblin-forwarded')).toBe('owner')
        // The agent's refusals and logs quote the edge's reference for the request.
        expect(request?.headers.get('x-goblin-ref')).toBe('ref-edge')
        expect(JSON.parse(request?.headers.get('x-goblin-caller') ?? '')).toEqual(caller)
        expect(request?.headers.get('authorization')).toBeNull()
      } finally {
        await mcp.close()
      }
    }
  })

  it('renames or closes a chat as the caller, a key and an OAuth client with goblin:conversations alike (ADR 0090)', async () => {
    for (const caller of [KEY, client(['goblin:conversations'])]) {
      const { mcp, seen } = await connect(caller, () => Response.json({ id: '12', title: 'Job 1, done' }))
      try {
        expect(await listed(caller)).toContain('conversation_update')
        await mcp.callTool({ name: 'conversation_update', arguments: { chat: '12', change: { closed: true } } })
        const [request] = seen
        expect([request?.method, new URL(request?.url ?? '').pathname]).toEqual(['PATCH', '/api/conversations/12'])
        expect(await request?.json()).toEqual({ closed: true })
      } finally {
        await mcp.close()
      }
    }
    expect(await listed(client([]))).not.toContain('conversation_update')
  })

  it('asks the agent in main with a bounded wait, and reads main back', async () => {
    const answer = { status: 'done', operationId: 'op-1', text: 'pong' }
    const { mcp, seen } = await connect(client([]), (request) =>
      Response.json(
        new URL(request.url).pathname === '/api/agent/ask' ? answer : { messages: [{ role: 'assistant', text: 'hi' }] },
      ),
    )
    try {
      const asked = await mcp.callTool({ name: 'ask_agent', arguments: { input: 'ping', operationId: 'op-1' } })
      expect(textOf(asked)).toEqual(answer)
      expect(await seen[0]?.json()).toEqual({ input: 'ping', operationId: 'op-1', waitMs: 50_000 })
      const tooLong = await mcp.callTool({ name: 'ask_agent', arguments: { input: 'ping', waitSeconds: 600 } })
      expect(tooLong.isError).toBe(true)
      const recent = await mcp.callTool({ name: 'get_recent_messages', arguments: { limit: 5 } })
      expect(textOf(recent)).toEqual({ messages: [{ role: 'assistant', text: 'hi' }] })
      expect(new URL(seen[1]?.url ?? '').searchParams.get('limit')).toBe('5')
    } finally {
      await mcp.close()
    }
  })

  it('passes an inspection read the fields it was given, by operation or by a chat entry', async () => {
    const { mcp, seen } = await connect(client(['goblin:inspect']), () =>
      Response.json({ events: [], related: [], coverage: { complete: true, gaps: [] } }),
    )
    try {
      const operation = 'persona:svc:job:1:first:7'
      await mcp.callTool({ name: 'inspect_turn', arguments: { operation } })
      expect(Object.fromEntries(new URL(seen[0]?.url ?? '').searchParams)).toEqual({ operation })
      expect((await mcp.callTool({ name: 'inspect_details', arguments: { operation } })).isError).not.toBe(true)
      await mcp.callTool({ name: 'inspect_details', arguments: { chat: '12', entry: 4 } })
      const byEntry = new URL(seen[2]?.url ?? '')
      expect([byEntry.pathname, Object.fromEntries(byEntry.searchParams)]).toEqual([
        '/api/inspect/details',
        { chat: '12', entry: '4' },
      ])
    } finally {
      await mcp.close()
    }
  })

  it("answers the agent's refusal as the tool's error result, its tag and safe fields only", async () => {
    const refusal = new BudgetExhausted({ limit: 2_000_000, resetsAt: 86_400 })
    const { mcp } = await connect(client([]), () => Response.json(envelopeOf(refusal), { status: 429 }))
    try {
      const refused = await mcp.callTool({ name: 'ask_agent', arguments: { input: 'ping' } })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toEqual({ _tag: 'BudgetExhausted', limit: 2_000_000, resetsAt: 86_400 })
    } finally {
      await mcp.close()
    }
  })
})
