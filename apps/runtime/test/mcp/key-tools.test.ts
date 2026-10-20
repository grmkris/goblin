import { Forbidden, OwnerApi, envelopeOf } from '@goblin/contracts/api'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { keyScopes } from '../../src/http/api/context.ts'
import { KEY_TOOLS, keyServer } from '../../src/inbound/api-server.ts'
import { ownerCall } from '../../src/inbound/client.ts'

const GRANT = { keyId: 'key-1', scopes: ['topics', 'conversations', 'personas'] as const, servers: ['mycut'] }

/** /mcp for a key over an agent that records what reached it and answers `reply`. */
const connect = async (reply: (request: Request) => Response) => {
  const seen: Request[] = []
  const agent = {
    fetch: async (request: Request) => {
      seen.push(request.clone())
      return reply(request)
    },
  }
  const handler = createMcpHandler(() => keyServer((call) => Effect.runPromise(ownerCall(agent, GRANT, call))))
  const client = new Client({ name: 'service', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp'), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    }),
  )
  return { client, seen }
}

const EMPTY = { entries: [], next: 7, more: false, activity: 'idle', invocations: [] }

describe("a server's API key on /mcp (ADR 0081)", () => {
  it('has exactly one tool for each owner endpoint a key reaches', () => {
    expect(Object.values(KEY_TOOLS).toSorted()).toEqual([...keyScopes(OwnerApi).keys()].toSorted())
  })

  it('lists the key tools only, reads marked read-only', async () => {
    const { client } = await connect(() => Response.json(EMPTY))
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(Object.keys(KEY_TOOLS).toSorted())
      const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)
      expect(readOnly.toSorted()).toEqual(['conversation_entries', 'persona_get'])
      expect(client.getInstructions()).toContain("never the owner's")
    } finally {
      await client.close()
    }
  })

  it("calls the owner API as the key: an owner forward carrying the key's grant", async () => {
    const { client, seen } = await connect(() => Response.json(EMPTY))
    try {
      const result = await client.callTool({ name: 'conversation_entries', arguments: { chat: '12', after: 6 } })
      expect(result.isError).not.toBe(true)
      // The tool's result is the endpoint's answer as one JSON text block.
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(EMPTY) }])
      const [request] = seen
      expect(request?.method).toBe('GET')
      expect(new URL(request?.url ?? '').pathname).toBe('/api/conversations/12/entries')
      expect(new URL(request?.url ?? '').searchParams.get('after')).toBe('6')
      expect(request?.headers.get('x-goblin-forwarded')).toBe('owner')
      expect(JSON.parse(request?.headers.get('x-goblin-key') ?? '')).toEqual(GRANT)
      expect(request?.headers.get('authorization')).toBeNull()
    } finally {
      await client.close()
    }
  })

  it("answers the agent's refusal as the tool's error result, its tag and reason only", async () => {
    const { client } = await connect(() =>
      Response.json(envelopeOf(new Forbidden({ reason: 'key_scope' })), { status: 403 }),
    )
    try {
      const result = await client.callTool({ name: 'persona_get', arguments: { id: 3 } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('key_scope')
    } finally {
      await client.close()
    }
  })
})
