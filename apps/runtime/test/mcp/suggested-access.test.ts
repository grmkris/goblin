import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { allowSuggested, suggestedPolicy } from '../../src/mcp/grants/suggested-access.ts'
import { toolView } from '../../src/mcp/servers/owner-servers.ts'
import { McpServers } from '../../src/mcp/service.ts'
import { lowLevelServer } from './low-level-server.ts'
import { hostOf } from './manager.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'

const NOTES = { connectionId: 'notes', endpoint: 'https://notes.example/mcp', label: 'Notes' }
const input = { type: 'object' as const, properties: {} }

/** A server whose tools say what they do: two read, one writes, one destroys while claiming to read, one says nothing. */
const notes = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'search', inputSchema: input, annotations: { readOnlyHint: true } },
      { name: 'read', inputSchema: input, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: 'write', inputSchema: input, annotations: { readOnlyHint: false } },
      { name: 'purge', inputSchema: input, annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: 'misc', inputSchema: input },
      { name: 'view', inputSchema: input, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['app'] } } },
    ],
  }))
  return server
})

const host = async () => {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture', token_type: 'bearer' }, 0)
  return hostOf({
    servers: [NOTES],
    credentials,
    grants: new MemoryGrants(),
    fetch: async (request, init) => notes.fetch(new Request(request, init)),
  })
}

describe('suggested access from tool annotations (ADR 0060)', () => {
  it('suggests run only for a tool that says it only reads and does not say it destroys', () => {
    expect(suggestedPolicy({ name: 'a', inputSchema: input, annotations: { readOnlyHint: true } })).toBe('run')
    expect(suggestedPolicy({ name: 'b', inputSchema: input })).toBe('ask')
    expect(
      suggestedPolicy({ name: 'c', inputSchema: input, annotations: { readOnlyHint: true, destructiveHint: true } }),
    ).toBe('ask')
  })

  it('grants nothing until the owner applies it, then allows every visible tool and holds the rest for a decision', async () => {
    const mcp = await host()
    try {
      const before = await mcp.run(McpServers.use((servers) => servers.tools('notes', false)))
      expect(before.every((tool) => !tool.granted)).toBe(true)
      expect(Object.fromEntries(before.map((tool) => [tool.name, tool.suggested]))).toMatchObject({
        search: 'run',
        read: 'run',
        write: 'ask',
        purge: 'ask',
        misc: 'ask',
      })
      const grants = (await mcp.run(allowSuggested('notes'))).filter((grant) => grant.capability === 'tool')
      expect(grants.map((grant) => grant.name).toSorted()).toEqual(['misc', 'purge', 'read', 'search', 'write'])
      expect(
        grants
          .filter((grant) => grant.askFirst)
          .map((grant) => grant.name)
          .toSorted(),
      ).toEqual(['misc', 'purge', 'write'])
    } finally {
      await mcp.dispose()
    }
  })

  it('keeps an ask-first switch the owner turned on for a tool suggested to run', async () => {
    const mcp = await host()
    try {
      await mcp.run(McpServers.use((servers) => servers.tools('notes', false)))
      await mcp.grants.setTool('notes', 'search', true)
      await mcp.grants.setAskFirst('notes', 'search', true)
      const grants = await mcp.run(allowSuggested('notes'))
      expect(grants.find((grant) => grant.name === 'search')?.askFirst).toBe(true)
    } finally {
      await mcp.dispose()
    }
  })
})

describe("a tool's input, as the owner's listing says it", () => {
  it('says a tool needs input only when its schema requires an argument', () => {
    const grants = new MemoryGrants()
    const find = { ...input, properties: { q: { type: 'string' } }, required: ['q'] }
    expect(toolView(grants, 'notes', { name: 'find', inputSchema: find }).needsInput).toBe(true)
    expect(toolView(grants, 'notes', { name: 'list', inputSchema: input })).not.toHaveProperty('needsInput')
    expect(toolView(grants, 'notes', { name: 'all', inputSchema: { ...input, required: [] } })).not.toHaveProperty(
      'needsInput',
    )
  })
})
