import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { MemoryCredentials, MemoryGrants } from './memory.ts'
import { lowLevelServer } from './low-level-server.ts'
import { BOARD, boardTools } from './notes-board.ts'
import { hostOf } from './manager.ts'

/** A notes server whose board App uses `open` (offered to the model) and `move` (App-only); `delete` is separate. */
const notes = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', boardTools)
  return server
})

async function host() {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
  return hostOf({
    servers: [{ connectionId: 'notes', endpoint: 'https://notes.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    fetch: async (input, init) => notes.fetch(new Request(input, init)),
  })
}

const allowed = async (mcp: Awaited<ReturnType<typeof host>>) =>
  (await mcp.grants.list()).map((grant) => `${grant.capability}:${grant.name}`).toSorted()

/**
 * A notes server whose tools change while goblin is connected: `extra` names a tool it lists now beyond the board's,
 * `down` makes it unreachable. `lists` counts its tools/list answers.
 */
const changing = () => {
  const state: { extra: string | undefined; down: boolean; lists: number } = { extra: undefined, down: false, lists: 0 }
  const official = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => {
      state.lists += 1
      const { tools } = boardTools()
      const extra = state.extra === undefined ? [] : [{ name: state.extra, inputSchema: { type: 'object' as const } }]
      return { tools: [...tools, ...extra] }
    })
    return server
  })
  return {
    state,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (state.down) throw new TypeError('network down')
      return official.fetch(new Request(input, init))
    },
  }
}

/** A signed-in host over the changing notes server. */
const changingHost = async (server: ReturnType<typeof changing>) => {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
  return hostOf({
    servers: [{ connectionId: 'notes', endpoint: 'https://notes.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    fetch: server.fetch,
  })
}

describe('granting against the tools the server lists now', () => {
  it('lists once more before refusing a tool goblin has not seen, and grants one the server just added', async () => {
    const server = changing()
    const mcp = await changingHost(server)
    try {
      await mcp.connections.connect('notes')
      server.state.extra = 'archive'
      await mcp.grants.setTool('notes', 'archive', true)
      expect(await allowed(mcp)).toEqual(['tool:archive'])
      await expect(mcp.grants.setTool('notes', 'nowhere', true)).rejects.toMatchObject({ _tag: 'NotFound' })
    } finally {
      await mcp.dispose()
    }
  })

  it('takes back a grant for a tool the server dropped, or while it cannot be reached', async () => {
    const server = changing()
    server.state.extra = 'archive'
    const mcp = await changingHost(server)
    try {
      await mcp.grants.setTool('notes', 'archive', true)
      await mcp.grants.setTool('notes', 'delete', true)
      server.state.extra = undefined
      await mcp.grants.setTool('notes', 'archive', false)
      expect(await allowed(mcp)).toEqual(['tool:delete'])
      await mcp.connections.close('notes')
      server.state.down = true
      await mcp.grants.setTool('notes', 'delete', false)
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })
})

describe('allowing an App as a whole', () => {
  it('grants exactly the tools that declare the App, and its resource; nothing else', async () => {
    const mcp = await host()
    try {
      await mcp.grants.setApp('notes', BOARD, true)
      expect(await allowed(mcp)).toEqual([`resource:${BOARD}`, 'tool:move', 'tool:open'])
      await mcp.grants.setApp('notes', BOARD, false)
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })
  it('refuses an App no tool declares', async () => {
    const mcp = await host()
    try {
      await expect(mcp.grants.setApp('notes', 'ui://notes/other.html', true)).rejects.toMatchObject({
        _tag: 'NotFound',
      })
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })
})

describe('changing tools in one batch', () => {
  it('grants only the selected names, keeps existing Ask first policy and version, and shares App resources', async () => {
    const mcp = await host()
    try {
      await mcp.grants.setTool('notes', 'open', true)
      await mcp.grants.setAskFirst('notes', 'open', true)
      const policy = await mcp.grants.policy('notes', 'open')
      const result = await mcp.grants.setTools('notes', ['open', 'move', 'move'], true)
      expect(result.missing).toEqual([])
      expect(await allowed(mcp)).toEqual([`resource:${BOARD}`, 'tool:move', 'tool:open'])
      expect(await mcp.grants.policy('notes', 'open')).toEqual(policy)
      await mcp.grants.setTools('notes', ['open'], false)
      expect(await allowed(mcp)).toEqual([`resource:${BOARD}`, 'tool:move'])
      await mcp.grants.setTools('notes', ['move'], false)
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })

  it('refreshes discovery once for every missing name and reports those still absent', async () => {
    const server = changing()
    const mcp = await changingHost(server)
    try {
      await mcp.connections.connect('notes')
      const lists = server.state.lists
      server.state.extra = 'archive'
      const result = await mcp.grants.setTools('notes', ['delete', 'archive', 'gone', 'gone-again'], true)
      expect(server.state.lists - lists).toBe(1)
      expect(result.missing).toEqual(['gone', 'gone-again'])
      expect(await allowed(mcp)).toEqual(['tool:archive', 'tool:delete'])
    } finally {
      await mcp.dispose()
    }
  })

  it('revokes dropped tools and App resources without connecting, even when the server is down', async () => {
    const server = changing()
    server.state.extra = 'archive'
    const mcp = await changingHost(server)
    try {
      await mcp.grants.setTools('notes', ['open', 'move', 'archive'], true)
      await mcp.connections.close('notes')
      server.state.down = true
      const result = await mcp.grants.setTools('notes', ['open', 'move', 'archive'], false)
      expect(result).toEqual({ grants: [], missing: [] })
      expect(await mcp.connections.snapshot('notes')).toMatchObject({ _tag: 'None' })
    } finally {
      await mcp.dispose()
    }
  })

  it('does not apply a partial batch when discovery fails', async () => {
    const server = changing()
    const mcp = await changingHost(server)
    try {
      await mcp.grants.setTool('notes', 'open', true)
      const before = await mcp.grants.list()
      server.state.down = true
      await expect(mcp.grants.setTools('notes', ['delete', 'unlisted'], true)).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
      })
      expect(await mcp.grants.list()).toEqual(before)
    } finally {
      await mcp.dispose()
    }
  })
})
