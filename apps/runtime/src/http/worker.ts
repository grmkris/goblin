import * as Effect from 'effect/Effect'
import type { AgentRpc, RuntimeEnv } from '../env.ts'
import { handleAuth, resourceMetadata, requireUserSession } from '../auth/index.ts'
import { readBytes } from './body.ts'
import { NotFound, attempt } from './errors.ts'
import { accountRecords } from './api/account.ts'
import { type Edge, type EdgeHttp, isAccountPath, makeEdgeHttp, runAtEdge } from './api/edge.ts'
import { secured } from './api/render.ts'
import { nowSeconds } from '../clock.ts'
import { fileLinkClaims } from '../files/link-token.ts'
import { deliverEvents, linkedFile } from '../inbound/client.ts'
import { handleInboundMcp } from '../inbound/route.ts'
import { eventsHookTokenValid } from '../mcp/events/route-token.ts'
import { EVENT_BODY_BYTES } from '../mcp/events/webhook.ts'
import { canonicalRedirect } from './canonical.ts'
import { healthOf } from './health.ts'

/** Only the authenticated user ID supplies the native Agent name. */
const agentOf = (env: RuntimeEnv, userId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(userId)

/** The deployment as the typed API's edge sees it (`http/api/edge.ts`). */
const edgeOf = (env: RuntimeEnv): Edge => ({
  origin: new URL(env.APP_URL).origin,
  session: (request) =>
    Effect.map(
      attempt(() => requireUserSession(request, env)),
      (session) => session.userId,
    ),
  agent: (userId) => agentOf(env, userId),
  records: accountRecords(env),
})

/** The edge, built once per isolate on its first request. */
let edgeHttp: Promise<EdgeHttp> | undefined
const edge = (): Promise<EdgeHttp> => (edgeHttp ??= runAtEdge(makeEdgeHttp))

/**
 * POST /hooks/mcp-events/<userId>/<connectionId>/<token>: one connection's MCP Events webhook. The route token, bound
 * to the user and the connection, is checked before any agent wakes, and the raw bytes are bounded before the agent
 * checks its authority and the signature.
 */
async function mcpEventsRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, userId = '', connectionId = '', token = ''] =
    /^\/hooks\/mcp-events\/([\w-]{1,200})\/([\w-]{1,64})\/([\w-]{43})$/u.exec(path) ?? []
  if (
    request.method !== 'POST' ||
    userId === '' ||
    !(await eventsHookTokenValid(env.CREDENTIAL_KEY, userId, connectionId, token))
  )
    throw new NotFound({ what: 'route' })
  const webhook = {
    connectionId,
    body: await readBytes(request, EVENT_BODY_BYTES),
    subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
    id: request.headers.get('webhook-id') ?? '',
    timestamp: request.headers.get('webhook-timestamp') ?? '',
    signature: request.headers.get('webhook-signature') ?? '',
  }
  const result = await runAtEdge(deliverEvents(agentOf(env, userId), webhook, ref))
  return new Response(result.response ?? null, {
    status: result.status,
    ...(result.response === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
}

/**
 * GET /files/link/<token>[/<name>]: one owner file handed to a server as a short-lived URL (ADR 0070). The token, signed
 * for this purpose and valid for fifteen minutes at most, names the user and the file; it is checked (in constant time)
 * before any agent wakes, and only the agent it names is asked for that file, never one a request parameter names. The
 * bytes go out as an attachment with their type, never cached and needing no cookie; anything else is a 404.
 */
async function fileLinkRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, token = ''] = /^\/files\/link\/([\w.-]{1,4200})(?:\/[^/]{0,1000})?$/u.exec(path) ?? []
  const claims =
    request.method === 'GET' && token !== '' ? await fileLinkClaims(env.CREDENTIAL_KEY, token, nowSeconds()) : undefined
  if (claims === undefined) throw new NotFound({ what: 'route' })
  const file = await runAtEdge(linkedFile(agentOf(env, claims.userId), claims.path, ref))
  return new Response(file.body, {
    headers: {
      'content-type': file.type ?? 'application/octet-stream',
      'content-disposition': file.disposition?.startsWith('attachment;') === true ? file.disposition : 'attachment',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    },
  })
}

/**
 * The Worker's own routes past the typed API: /mcp, the hooks and file links. Anything else, `/internal/*` included,
 * is a 404.
 */
async function workerRoute(request: Request, env: RuntimeEnv, ref: string): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/mcp') return handleInboundMcp(request, env)
  if (path.startsWith('/hooks/mcp-events/')) return mcpEventsRoute(request, env, path, ref)
  if (path.startsWith('/files/link/')) return fileLinkRoute(request, env, path, ref)
  throw new NotFound({ what: 'route' })
}

/**
 * The deployed Worker's handler (`worker.ts` exports it with the agent's class): every request the web worker forwards
 * (`apps/web/src/worker.ts`): health, auth, the typed API's edge, /mcp, the hooks and file links.
 */
export const worker = {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json(healthOf(env))
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(resourceMetadata(env)), undefined)
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/'))
      return handleAuth(request, env)
    // The typed API: the account's own endpoints answered here, every other `/api/*` request admitted and forwarded
    // to the owner's own agent (http/api/edge.ts).
    if (isAccountPath(url.pathname)) return runAtEdge((await edge()).account(request, edgeOf(env)))
    if (url.pathname.startsWith('/api/')) return runAtEdge((await edge()).owner(request, edgeOf(env)))

    // Every answer quotes the request's reference (its cf-ray), which its failure line carries too.
    return runAtEdge((await edge()).route(request, (ref) => attempt(() => workerRoute(request, env, ref))))
  },
}
