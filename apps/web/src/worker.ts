import page from './server.tsx'
import runtime from '@goblin/runtime/worker'
import { canonicalRedirect } from '@goblin/runtime/canonical'
import { robotsTxt } from './lib/robots.ts'
export { PersonalAgent } from '@goblin/runtime/agent'
// Each chat's AG-UI stream (docs/architecture/streams.md), one object per epoch, which the agent appends to.
export { StreamObject } from '@durable-streams/server-cloudflare'

export default {
  async fetch(request: Request, env: Parameters<typeof runtime.fetch>[1]): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (
      url.pathname.startsWith('/api/') ||
      /^\/w\/[^/]+\/api\//u.test(url.pathname) ||
      url.pathname.startsWith('/hooks/') ||
      url.pathname.startsWith('/files/link/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname === '/health' ||
      url.pathname === '/mcp'
    )
      return runtime.fetch(request, env)
    if (url.pathname === '/robots.txt')
      return new Response(robotsTxt(env.STAGE), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      })
    return page.fetch(request)
  },
}
