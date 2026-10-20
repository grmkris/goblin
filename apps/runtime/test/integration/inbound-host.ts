import { createMcpHandler } from 'agents/mcp/server'
import { inboundHosts } from '../../src/inbound/route.ts'
import { mcpServer } from '../../src/inbound/mcp-server.ts'

/** Fixture transport uses the real Agents SDK on a custom host; authentication is tested separately. */
export function inboundHostProbe(request: Request): Promise<Response> {
  const url = new URL('https://dev.goblin.surf/mcp')
  const headers = new Headers(request.headers)
  headers.set('host', url.host)
  const handler = createMcpHandler(
    () =>
      mcpServer(['agent'], async () => {
        throw new Error('no agent behind the host probe')
      }),
    { route: '/mcp', ...inboundHosts(url.origin) },
  )
  return handler.fetch(new Request(url, { method: request.method, headers, body: request.body }))
}
