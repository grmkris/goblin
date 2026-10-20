import { createMcpHandler } from 'agents/mcp/server'
import { verifyKey } from '../auth/api-keys.ts'
import { INSPECT_SCOPE, challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { runAtEdge } from '../http/api/edge.ts'
import { bearerKey } from '../http/api/principal.ts'
import { keyServer } from './api-server.ts'
import { internalCall, ownerCall } from './client.ts'
import type { InspectReader } from './inspection.ts'
import { inboundServer } from './server.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * `/mcp` for a server's API key (ADR 0081): the key verified, then its tools, each an owner API call as the key to the
 * agent of the user who made it. A key that does not admit is a plain 401: there is nothing to sign in to.
 */
const keyMcp = async (request: Request, env: RuntimeEnv, key: string): Promise<Response> => {
  let principal: Awaited<ReturnType<typeof verifyKey>>
  try {
    principal = await verifyKey(env, key)
  } catch {
    // expected: a key that does not verify (unknown, revoked, expired, over its limit) is refused, saying no more.
    return Response.json({ error: 'Unauthenticated' }, { status: 401 })
  }
  const { userId, ...grant } = principal
  const agent = env.AGENTS.getByName(userId)
  const handler = createMcpHandler(() => keyServer((call) => runAtEdge(ownerCall(agent, grant, call))), {
    route: '/mcp',
    ...inboundHosts(env.APP_URL),
  })
  return handler.fetch(request, { authInfo: { token: key, clientId: `key:${grant.keyId}`, scopes: [...grant.scopes] } })
}

/** `/mcp`: verify the client's bearer token, then serve the stateless MCP handler bound to that client. */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const key = bearerKey(request)
  if (key !== undefined) return keyMcp(request, env, key)
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challengeOf(env.APP_URL)
  const token = header.slice('Bearer '.length)
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    // expected: a token that does not verify is answered with the sign-in challenge, as a missing one is.
    return challengeOf(env.APP_URL)
  }
  // The token's subject is the user who consented; the client talks to that user's agent only, through its internal
  // API.
  const agent = env.AGENTS.getByName(principal.subject)
  const name = await clientName(principal.clientId, env)
  const inspect: InspectReader = (query) =>
    runAtEdge(internalCall(agent, (api) => api.inbound.inspect({ payload: { query } })))
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: (input, operationId, waitMs) =>
          runAtEdge(
            internalCall(agent, (api) =>
              api.inbound.ask({ payload: { author: name ?? 'an MCP client', input, operationId, waitMs } }),
            ),
          ),
        recent: (limit) => runAtEdge(internalCall(agent, (api) => api.inbound.recent({ query: { limit } }))),
        ...(principal.scopes.includes(INSPECT_SCOPE) ? { inspect } : {}),
      }),
    {
      route: '/mcp',
      // The canonical host is configuration, not the request's Host/Origin. This keeps custom domains valid while
      // retaining the SDK's DNS-rebinding protection; the Worker redirects alternate hosts before reaching here.
      ...inboundHosts(env.APP_URL),
    },
  )
  return handler.fetch(request, {
    authInfo: { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt },
  })
}
