import { type Extra, GRANT_SPEC, type Level, missingFor } from '@goblin/contracts'
import { AccessInsufficient, BudgetExhausted, OwnerApi, envelopeOf, accessInsufficient } from '@goblin/contracts/api'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { endpointAccess } from '../../src/http/api/context.ts'
import type { Credential } from '../../src/http/api/principal.ts'
import { accessElicitation } from '../../src/inbound/access.ts'
import { ownerCall } from '../../src/inbound/client.ts'
import { type CallerReach, mcpServer } from '../../src/inbound/mcp-server.ts'
import { workspaceFor } from '../../src/inbound/reach.ts'
import { type OwnerCaller, STREAMED, TOOLS } from '../../src/inbound/tools.ts'
import { EVENT_METHODS } from '../../src/inbound/events-methods.ts'
import { credential } from '../grants-fixture.ts'

const KEY = credential({ id: 'key-1', name: 'swarmm', level: 'manage' })
/** An OAuth client a person approved with a grant of `level` and `extras` (ADR 0114). */
const client = (level: Level = 'write', extras: readonly Extra[] = []): Credential =>
  credential({ kind: 'client', id: 'claude-code', name: 'Claude Code', grantId: 'cg_1', level, extras })

/** /mcp for `caller` over an agent that records what reached it and answers `reply`. */
const connect = async (caller: Credential, reply: (request: Request) => Response = () => Response.json({})) => {
  const seen: Request[] = []
  const agent = {
    fetch: async (request: Request) => {
      seen.push(request.clone())
      return reply(request)
    },
  }
  const handler = createMcpHandler(() =>
    mcpServer(caller, (call) =>
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

const listed = async (caller: Credential) => {
  const { mcp } = await connect(caller)
  try {
    return (await mcp.listTools()).tools.map((tool) => tool.name).toSorted()
  } finally {
    await mcp.close()
  }
}

/** The tools whose endpoints a grant of `level` with `extras` holds, from the contract alone. */
const toolsFor = (level: Level, extras: readonly Extra[] = []) => {
  const needs = endpointAccess(OwnerApi)
  return Object.entries(TOOLS)
    .filter(([, endpoint]) => {
      const need = needs.get(endpoint)
      return need !== undefined && missingFor(GRANT_SPEC, { level, extras }, need) === null
    })
    .map(([name]) => name)
    .toSorted()
}
const textOf = (result: { readonly content?: unknown }): unknown =>
  // SAFETY: every goblin tool answers one text block (`text` and `failed` in inbound/tools.ts).
  JSON.parse((result.content as readonly { readonly text: string }[])[0]?.text ?? 'null')

describe('/mcp for every credential (ADRs 0086, 0114)', () => {
  it('has exactly one tool or Events method for each owner endpoint a credential reaches, but the streams it reads over HTTP', () => {
    const reached = [...endpointAccess(OwnerApi).keys()]
    expect([...Object.values(TOOLS), ...Object.values(EVENT_METHODS)].toSorted()).toEqual(
      reached.filter((endpoint) => !STREAMED.has(endpoint)).toSorted(),
    )
    expect(reached).toEqual(expect.arrayContaining([...STREAMED]))
  })

  it("lists only what a grant's level and extras hold: reads, then writes, then settings, then each extra", async () => {
    const reads = await listed(client('read'))
    expect(reads).toEqual(toolsFor('read'))
    expect(reads).toEqual(expect.arrayContaining(['access_read', 'topic_list', 'persona_get', 'conversation_entries']))
    expect(reads).not.toContain('conversation_send')
    const writes = await listed(client('write'))
    expect(writes).toEqual(toolsFor('write'))
    expect(writes).toEqual(expect.arrayContaining(['conversation_send', 'topic_create', 'ask_agent']))
    expect(writes).not.toContain('persona_create')
    expect(writes.filter((tool) => tool.startsWith('inspect_') || tool.startsWith('routine_'))).toEqual([])
    expect(await listed(client('manage'))).toEqual(expect.arrayContaining(['persona_create', 'topic_update']))
    expect(await listed(client('manage'))).not.toContain('topic_set_setup')
    expect(await listed(client('read', ['inspect']))).toEqual(toolsFor('read', ['inspect']))
    expect(await listed(client('read', ['inspect']))).toContain('inspect_conversation')
    expect(await listed(client('manage', ['setup', 'routines', 'inspect']))).toEqual(Object.keys(TOOLS).toSorted())
  })

  it('lists the same tools for a key and an OAuth client with the same grant', async () => {
    for (const [level, extras] of [
      ['read', []],
      ['write', ['inspect']],
      ['manage', ['setup', 'routines']],
    ] as const) {
      const keyed = await listed(credential({ level, extras }))
      expect(keyed).toEqual(await listed(client(level, extras)))
      expect(keyed).toEqual(toolsFor(level, extras))
    }
  })

  it('calls the owner API as the credential: an owner forward carrying it, never a secret', async () => {
    const page = { personas: [] }
    for (const caller of [KEY, client('read')]) {
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

  it('renames or closes a chat as the credential, a key and an OAuth client that write alike (ADR 0090)', async () => {
    for (const caller of [KEY, client('write')]) {
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
    expect(await listed(client('read'))).not.toContain('conversation_update')
  })

  it('sends and starts threads with plain fields, as the AG-UI input the endpoints take (ADR 0111)', async () => {
    const receipt = { operationId: 'op-1', session: '12', accepted: true }
    const { mcp, seen } = await connect(KEY, () => Response.json(receipt, { status: 202 }))
    const selections = [{ kind: 'persona', personaId: 4 }]
    try {
      const message = { input: 'find the venue', operationId: 'op-1', selections }
      await mcp.callTool({ name: 'conversation_send', arguments: { chat: '12', message } })
      const thread = { operationId: 'op-2', anchor: 'empty', title: 'Job 2', message: { input: 'start' } }
      await mcp.callTool({ name: 'thread_start', arguments: { chat: '12', thread } })
      const [send, start] = seen
      expect(new URL(send?.url ?? '').pathname).toBe('/api/conversations/12/messages')
      expect(await send?.json()).toEqual({
        threadId: '12',
        runId: 'op-1',
        messages: [{ id: 'op-1', role: 'user', content: 'find the venue' }],
        forwardedProps: { goblin: { selections } },
      })
      expect(new URL(start?.url ?? '').pathname).toBe('/api/conversations/12/threads')
      expect(await start?.json()).toEqual({
        anchor: 'empty',
        title: 'Job 2',
        message: { threadId: '12', runId: 'op-2', messages: [{ id: 'op-2', role: 'user', content: 'start' }] },
      })
    } finally {
      await mcp.close()
    }
  })

  it('asks the agent in main with a bounded wait, and reads main back', async () => {
    const answer = { status: 'done', operationId: 'op-1', text: 'pong' }
    const { mcp, seen } = await connect(client('write'), (request) =>
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
    const { mcp, seen } = await connect(client('read', ['inspect']), () =>
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
    const { mcp } = await connect(client('write'), () => Response.json(envelopeOf(refusal), { status: 429 }))
    try {
      const refused = await mcp.callTool({ name: 'ask_agent', arguments: { input: 'ping' } })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toEqual({ _tag: 'BudgetExhausted', limit: 2_000_000, resetsAt: 86_400 })
    } finally {
      await mcp.close()
    }
  })

  it('answers a refusal for want of access with what is missing and the link to widen it', async () => {
    const refusal = accessInsufficient('https://goblin.test', 'cg_1', { reachId: 'w1/topic/1' })
    const { mcp } = await connect(client('write'), () => Response.json(envelopeOf(refusal), { status: 403 }))
    try {
      const refused = await mcp.callTool({ name: 'ask_agent', arguments: { input: 'ping' } })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toEqual({
        _tag: 'AccessInsufficient',
        missing: { reachId: 'w1/topic/1' },
        widenUrl: 'https://goblin.test/consent/widen?grant=cg_1&reach=w1%2Ftopic%2F1',
      })
    } finally {
      await mcp.close()
    }
  })
})

const widenUrl = new AccessInsufficient({ missing: { extra: 'inspect' }, widenUrl: 'https://goblin.test/w' }).widenUrl
/** A call's context as a client's request carries it: its capabilities, its answers so far and the dropped ones. */
const context = (capabilities: object | undefined, responses?: Record<string, unknown>, dropped: string[] = []) => ({
  capabilities,
  inputResponses: responses,
  dropped,
  tasks: false,
})

describe('the widening asked for by URL elicitation (ADR 0114)', () => {
  it('asks a client that declares URL elicitation to open the widening page, once per call', () => {
    expect(accessElicitation(context({ elicitation: { url: {} } }), widenUrl)).toEqual({
      resultType: 'input_required',
      inputRequests: {
        access: {
          method: 'elicitation/create',
          params: expect.objectContaining({ mode: 'url', url: widenUrl }),
        },
      },
    })
  })

  it('keeps the plain refusal for a client that cannot, or once the ask was answered or dropped', () => {
    expect(accessElicitation(undefined, widenUrl)).toBeNull()
    expect(accessElicitation(context({ elicitation: { form: {} } }), widenUrl)).toBeNull()
    expect(
      accessElicitation(context({ elicitation: { url: {} } }, { access: { action: 'accept' } }), widenUrl),
    ).toBeNull()
    expect(accessElicitation(context({ elicitation: { url: {} } }, {}, ['access']), widenUrl)).toBeNull()
  })
})

const A = { id: 'ws-a', slug: 'swarmm', name: 'Swarmm', role: 'owner', members: 2 } as const
const B = { id: 'ws-b', slug: 'sidequest', name: 'Sidequest', role: 'member', members: 3 } as const

/** A client reaching `workspaces`, every call recorded with the workspace it named. */
const reaching = async (reach: CallerReach) => {
  const calls: (string | undefined)[] = []
  const call: OwnerCaller = async (_run, workspace) => {
    calls.push(workspace)
    // SAFETY: the tools under test only pass the answer on as their result.
    return {} as never
  }
  const handler = createMcpHandler(() => mcpServer({ level: 'write', extras: [] }, call, reach))
  const mcp = new Client({ name: 'probe', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp'), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    }),
  )
  return { mcp, calls }
}

describe('one /mcp, the workspaces a consent reaches (ADR 0097)', () => {
  it('has every tool name the workspace a call is for when the client reaches several, and lists them', async () => {
    const { mcp, calls } = await reaching({ all: true, workspaces: [A, B], named: true })
    try {
      const { tools } = await mcp.listTools()
      const topics = tools.find((tool) => tool.name === 'topic_list')
      expect(topics?.inputSchema.required).toContain('workspace')
      const list = tools.find((tool) => tool.name === 'workspace_list')
      expect(list?.inputSchema.properties ?? {}).not.toHaveProperty('workspace')
      await mcp.callTool({ name: 'topic_list', arguments: { workspace: 'sidequest' } })
      expect(calls).toEqual(['sidequest'])
      const listedReach = textOf(await mcp.callTool({ name: 'workspace_list', arguments: {} }))
      expect(listedReach).toEqual({ all: true, workspaces: [A, B] })
      expect(mcp.getInstructions()).toContain("all of its person's workspaces")
    } finally {
      await mcp.close()
    }
  })

  it('needs no workspace from a client given exactly one, yet checks one it names after its reach shrank', async () => {
    const { mcp, calls } = await reaching({ all: false, workspaces: [A], named: false })
    try {
      const { tools } = await mcp.listTools()
      const topics = tools.find((tool) => tool.name === 'topic_list')
      expect(topics?.inputSchema.properties).toHaveProperty('workspace')
      expect(topics?.inputSchema.required ?? []).not.toContain('workspace')
      await mcp.callTool({ name: 'topic_list', arguments: {} })
      // A name from a tool list older than its reach reaches the resolver, which refuses one it no longer reaches.
      await mcp.callTool({ name: 'topic_list', arguments: { workspace: 'sidequest' } })
      expect(calls).toEqual([undefined, 'sidequest'])
      expect(mcp.getInstructions()).not.toContain(A.name)
    } finally {
      await mcp.close()
    }
  })

  it('resolves a call to a workspace the consent reaches, by id or slug, and refuses anything else', () => {
    const named: CallerReach = { all: false, workspaces: [A, B], named: true }
    expect(workspaceFor(named, 'ws-b')).toBe(B)
    expect(workspaceFor(named, 'swarmm')).toBe(A)
    expect(() => workspaceFor(named, undefined)).toThrow(expect.objectContaining({ reason: 'workspace' }))
    expect(() => workspaceFor(named, 'elsewhere')).toThrow(expect.objectContaining({ what: 'workspace' }))
    expect(workspaceFor({ all: false, workspaces: [A], named: false }, undefined)).toBe(A)
    expect(() => workspaceFor({ all: false, workspaces: [A], named: false }, 'sidequest')).toThrow()
    // An id wins over a slug that looks like it.
    const lookalike = { ...B, slug: A.id }
    expect(workspaceFor({ all: false, workspaces: [lookalike, A], named: true }, A.id)).toBe(A)
    expect(() => workspaceFor({ all: false, workspaces: [], named: true }, undefined)).toThrow()
  })
})
