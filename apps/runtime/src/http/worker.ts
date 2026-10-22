import * as Effect from 'effect/Effect'
import type { AgentRpc, RuntimeEnv } from '../env.ts'
import { handleAuth, resourceMetadata, requireUserSession } from '../auth/index.ts'
import { verifyKey } from '../auth/api-keys.ts'
import { readBytes } from './body.ts'
import { NotFound, attempt } from './errors.ts'
import { accountRecords } from './api/account.ts'
import { type Edge, type EdgeHttp, isAccountPath, isWorkspacePath, makeEdgeHttp, runAtEdge } from './api/edge.ts'
import { membershipAt, membershipOf } from '../auth/workspaces.ts'
import { secured } from './api/render.ts'
import { nowSeconds } from '../clock.ts'
import { fileLinkClaims } from '../files/link-token.ts'
import { deliverEvents, linkedFile } from '../inbound/client.ts'
import { handleInboundMcp } from '../inbound/route.ts'
import { eventsHookTokenValid } from '../mcp/events/route-token.ts'
import { EVENT_BODY_BYTES } from '../mcp/events/webhook.ts'
import { SIGN_IN_CALLBACK } from '../mcp/oauth/sign-in.ts'
import { canonicalRedirect } from './canonical.ts'
import { healthOf } from './health.ts'
import { streamRoute } from './streams.ts'

/**
 * A workspace's agent (ADR 0089): its name is the workspace's ID, which only a membership, a key, a consent or a signed
 * token supplies, never a request by itself.
 */
const agentOf = (env: RuntimeEnv, workspaceId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(workspaceId)

/** The deployment as the typed API's edge sees it (`http/api/edge.ts`). */
const edgeOf = (env: RuntimeEnv): Edge => ({
  origin: new URL(env.APP_URL).origin,
  session: (request) =>
    Effect.map(
      attempt(() => requireUserSession(request, env)),
      (session) => session.person,
    ),
  key: (key) => attempt(() => verifyKey(env, key)),
  membership: (userId, slug) => attempt(() => membershipAt(env.AUTH_DB, userId, slug)),
  membershipOf: (userId, workspaceId) => attempt(() => membershipOf(env.AUTH_DB, userId, workspaceId)),
  agent: (workspaceId) => agentOf(env, workspaceId),
  records: accountRecords(env),
})

/** The edge, built once per isolate on its first request. */
let edgeHttp: Promise<EdgeHttp> | undefined
const edge = (): Promise<EdgeHttp> => (edgeHttp ??= runAtEdge(makeEdgeHttp))

/**
 * POST /hooks/mcp-events/<workspaceId>/<connectionId>/<token>: one connection's MCP Events webhook. The route token,
 * bound to the workspace's agent and the connection, is checked before any agent wakes, and the raw bytes are bounded
 * before the agent checks its authority and the signature.
 */
async function mcpEventsRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, workspaceId = '', connectionId = '', token = ''] =
    /^\/hooks\/mcp-events\/([\w-]{1,200})\/([\w-]{1,64})\/([\w-]{43})$/u.exec(path) ?? []
  if (
    request.method !== 'POST' ||
    workspaceId === '' ||
    !(await eventsHookTokenValid(env.CREDENTIAL_KEY, workspaceId, connectionId, token))
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
  const result = await runAtEdge(deliverEvents(agentOf(env, workspaceId), webhook, ref))
  return new Response(result.response ?? null, {
    status: result.status,
    ...(result.response === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
}

/**
 * GET /files/link/<token>[/<name>]: one workspace file handed to a server as a short-lived URL (ADR 0070). The token,
 * signed for this purpose and valid for fifteen minutes at most, names the agent and the file; it is checked (in
 * constant time) before any agent wakes, and only the agent it names is asked for that file, never one a request
 * parameter names. The bytes go out as an attachment with their type, never cached and needing no cookie; anything
 * else is a 404.
 */
async function fileLinkRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, token = ''] = /^\/files\/link\/([\w.-]{1,4200})(?:\/[^/]{0,1000})?$/u.exec(path) ?? []
  const claims =
    request.method === 'GET' && token !== '' ? await fileLinkClaims(env.CREDENTIAL_KEY, token, nowSeconds()) : undefined
  if (claims === undefined) throw new NotFound({ what: 'route' })
  const file = await runAtEdge(linkedFile(agentOf(env, claims.workspaceId), claims.path, ref))
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
 * The Worker's own routes past the typed API: /mcp, the hooks, file links and chat streams. Anything else,
 * `/internal/*` included, is a 404.
 */
async function workerRoute(request: Request, env: RuntimeEnv, ref: string): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/mcp') return handleInboundMcp(request, env)
  if (path.startsWith('/hooks/mcp-events/')) return mcpEventsRoute(request, env, path, ref)
  if (path.startsWith('/files/link/')) return fileLinkRoute(request, env, path, ref)
  if (path.startsWith('/streams/')) return streamRoute(request, env, path)
  throw new NotFound({ what: 'route' })
}

/**
 * The deployed Worker's handler (`worker.ts` exports it with the agent's class): every request the web worker forwards
 * (`apps/web/src/worker.ts`): health, auth, the typed API's edge, /mcp, the hooks, file links and chat streams.
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
    // The typed API (http/api/edge.ts): a person's account endpoints answered here; a member's requests, under their
    // workspace's path, answered here or forwarded to its agent; and a key's `/api/*` requests forwarded to its own.
    if (isAccountPath(url.pathname)) return runAtEdge((await edge()).account(request, edgeOf(env)))
    if (isWorkspacePath(url.pathname)) return runAtEdge((await edge()).workspace(request, edgeOf(env)))
    if (url.pathname === SIGN_IN_CALLBACK) return runAtEdge((await edge()).signIn(request, edgeOf(env)))
    if (url.pathname.startsWith('/api/')) return runAtEdge((await edge()).owner(request, edgeOf(env)))

    // Every answer quotes the request's reference (its cf-ray), which its failure line carries too.
    return runAtEdge((await edge()).route(request, (ref) => attempt(() => workerRoute(request, env, ref))))
  },
}
