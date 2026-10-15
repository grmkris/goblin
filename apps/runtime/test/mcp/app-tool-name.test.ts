import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { lowLevelServer } from './low-level-server.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'

describe('an MCP App calling its exact exposed tool name', () => {
  it('accepts the connector-prefixed name and refuses the unlisted bare name before dispatch', async () => {
    const name = 'mymedia_media_view'
    const dispatched: string[] = []
    const official = createMcpHandler(() => {
      const server = lowLevelServer({ name: 'connector', version: '1' }, { capabilities: { tools: {} } })
      server.setRequestHandler('tools/list', () => ({
        tools: [
          {
            name,
            inputSchema: { type: 'object' },
            _meta: { ui: { resourceUri: 'ui://media/view', visibility: ['model', 'app'] } },
          },
        ],
      }))
      server.setRequestHandler('tools/call', (request) => {
        dispatched.push(request.params.name)
        return { content: [{ type: 'text', text: request.params.name }] }
      })
      return server
    })
    // Grant both spellings so the bare name must fail the manager's exact listed-name check, not its grant check.
    let allowed = true
    const grants = new MemoryGrants(
      [name, 'media_view'].map((tool) => ({ connectionId: 'connector', capability: 'tool' as const, name: tool })),
    )
    const manager = managerOf({
      servers: [{ connectionId: 'connector', endpoint: 'https://connector.test/mcp' }],
      allows: (grant) => allowed && grants.allows(grant),
      auth: () => ({ token: async () => 'fixture' }),
      fetch: async (input, init) => official.fetch(new Request(input, init)),
    })
    try {
      expect(await manager.connections.callTool('connector', name, {}, { caller: 'app' })).toMatchObject({
        content: [{ type: 'text', text: name }],
      })
      await expect(
        manager.connections.callTool('connector', 'media_view', {}, { caller: 'app' }),
      ).rejects.toMatchObject({
        _tag: 'NotFound',
      })
      expect(dispatched).toEqual([name])
      allowed = false
      await expect(manager.connections.callTool('connector', name, {}, { caller: 'app' })).rejects.toMatchObject({
        _tag: 'GrantDenied',
      })
      expect(dispatched).toEqual([name])
    } finally {
      await manager.dispose()
      await official.close()
    }
  })
})
