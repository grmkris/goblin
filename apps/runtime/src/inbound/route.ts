import { createMcpHandler } from 'agents/mcp/server'
import { verifyKey } from '../auth/api-keys.ts'
import { challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import { callerScopesOf } from '../auth/resources.ts'
import type { RuntimeEnv } from '../env.ts'
import { runAtEdge } from '../http/api/edge.ts'
import { type Caller, type Member, bearerKey, callerId } from '../http/api/principal.ts'
import { membershipOf } from '../auth/workspaces.ts'
import { ownerCall } from './client.ts'
import { mcpServer } from './mcp-server.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * Who a bearer on /mcp is, and the workspace whose agent it reaches (ADR 0089): a key's own, or the one its person's
 * consent names, with that person as the member an OAuth client acts for.
 */
type Admitted = {
  readonly workspaceId: string
  readonly caller: Caller
  readonly member?: Member
  readonly token: string
  readonly expiresAt?: number
}

/**
 * A server's API key (ADR 0081), or an OAuth client the owner consented to (ADR 0024) with what its consent grants
 * now (ADR 0086). A key that does not admit rejects with its `Unauthenticated`, which the Worker answers in the
 * envelope `/api` uses: there is nothing to sign in to. An OAuth token that does not verify, or no bearer at all, is
 * answered with the sign-in challenge.
 */
const admit = async (request: Request, env: RuntimeEnv): Promise<Admitted | undefined> => {
  const key = bearerKey(request)
  if (key !== undefined) {
    const { workspaceId, ...grant } = await verifyKey(env, key)
    return { workspaceId, caller: { kind: 'key', ...grant }, token: key }
  }
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length)
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    // expected: a token that does not verify is answered with the sign-in challenge, as a missing one is.
    return undefined
  }
  const name = (await clientName(principal.clientId, env)) ?? 'an MCP client'
  const membership = await membershipOf(env.AUTH_DB, principal.subject, principal.workspaceId)
  if (membership === undefined) return undefined
  return {
    workspaceId: principal.workspaceId,
    caller: { kind: 'client', clientId: principal.clientId, name, scopes: callerScopesOf(principal.scopes) },
    member: { user: principal.subject, role: membership.role },
    token,
    expiresAt: principal.expiresAt,
  }
}

/**
 * `/mcp` (ADR 0086): one server for every caller, its tools those the caller's scopes reach, each an owner API call as
 * that caller to the agent of its workspace. A key or a token reaches only its own workspace's agent (ADR 0089).
 */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const admitted = await admit(request, env)
  if (admitted === undefined) return challengeOf(env.APP_URL)
  const { workspaceId, caller, member, token, expiresAt } = admitted
  const agent = env.AGENTS.getByName(workspaceId)
  const handler = createMcpHandler(
    () => mcpServer(caller.scopes, (call) => runAtEdge(ownerCall(agent, caller, member, call))),
    {
      route: '/mcp',
      // The canonical host is configuration, not the request's Host/Origin. This keeps custom domains valid while
      // retaining the SDK's DNS-rebinding protection; the Worker redirects alternate hosts before reaching here.
      ...inboundHosts(env.APP_URL),
    },
  )
  return handler.fetch(request, {
    authInfo: {
      token,
      clientId: callerId(caller),
      scopes: [...caller.scopes],
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  })
}
