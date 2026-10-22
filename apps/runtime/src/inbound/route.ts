import { createMcpHandler } from 'agents/mcp/server'
import type { WorkspaceView } from '@goblin/contracts'
import { verifyKey } from '../auth/api-keys.ts'
import { challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import { callerScopesOf } from '../auth/resources.ts'
import { reachedBy } from '../auth/workspaces.ts'
import type { RuntimeEnv } from '../env.ts'
import { refOf, runAtEdge } from '../http/api/edge.ts'
import { type Caller, bearerKey, callerId, memberName } from '../http/api/principal.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { ownerCall } from './client.ts'
import { type CallerReach, mcpServer } from './mcp-server.ts'
import type { OwnerCaller } from './tools.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * Who a bearer on /mcp is, and which agents it reaches: a key its own workspace's (ADR 0089); an OAuth client those of
 * the workspaces its person's consent reaches now (ADR 0097), acting for that person as a member of each.
 */
type Admitted =
  | { readonly kind: 'key'; readonly workspaceId: string; readonly caller: Caller; readonly token: string }
  | {
      readonly kind: 'client'
      readonly caller: Caller
      readonly person: { readonly user: string; readonly name: string }
      readonly reach: CallerReach
      readonly token: string
      readonly expiresAt: number
    }

/**
 * A server's API key (ADR 0081), or an OAuth client a person consented to (ADR 0024) with what its consent grants now
 * (ADR 0086) and the workspaces it reaches now (ADR 0097). A key that does not admit rejects with its
 * `Unauthenticated`, which the Worker answers in the envelope `/api` uses: there is nothing to sign in to. An OAuth
 * token that does not verify, or no bearer at all, is answered with the sign-in challenge.
 */
const admit = async (request: Request, env: RuntimeEnv): Promise<Admitted | undefined> => {
  const key = bearerKey(request)
  if (key !== undefined) {
    const { workspaceId, ...grant } = await verifyKey(env, key)
    return { kind: 'key', workspaceId, caller: { kind: 'key', ...grant }, token: key }
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
  const [name, reached, person] = await Promise.all([
    clientName(principal.clientId, env),
    reachedBy(env.AUTH_DB, principal.subject, principal.clientId),
    env.AUTH_DB.prepare('SELECT name, email FROM user WHERE id = ?')
      .bind(principal.subject)
      .first<{ name: string; email: string }>(),
  ])
  if (person === null) return undefined
  const workspaces = reached?.workspaces ?? []
  const all = reached?.all ?? false
  return {
    kind: 'client',
    caller: {
      kind: 'client',
      clientId: principal.clientId,
      name: name ?? 'an MCP client',
      scopes: callerScopesOf(principal.scopes),
    },
    person: { user: principal.subject, name: memberName(person) },
    // A client given exactly one workspace never names it; "all" always does, so joining another never changes what
    // a call without a workspace means.
    reach: { all, workspaces, named: all || workspaces.length !== 1 },
    token,
    expiresAt: principal.expiresAt,
  }
}

/**
 * The workspace a client's call is for: the one it names, by id or slug, or its only one when it names none.
 *
 * @internal Exported for its unit test.
 */
export const workspaceFor = (reach: CallerReach, named: string | undefined): WorkspaceView => {
  const [only] = reach.workspaces
  if (named === undefined) {
    if (reach.named || only === undefined) throw new InvalidInput({ reason: 'workspace' })
    return only
  }
  const chosen = reach.workspaces.find((workspace) => workspace.id === named || workspace.slug === named)
  if (chosen === undefined) throw new NotFound({ what: 'workspace' })
  return chosen
}

/** How each tool call reaches its agent: a key's own workspace, or the client's workspace the call names. */
const callerOf = (admitted: Admitted, env: RuntimeEnv, ref: string): OwnerCaller => {
  if (admitted.kind === 'key') {
    const agent = env.AGENTS.getByName(admitted.workspaceId)
    return (call) => runAtEdge(ownerCall(agent, admitted.caller, undefined, call, { ref }))
  }
  const { caller, person, reach } = admitted
  return async (call, named) => {
    const workspace = workspaceFor(reach, named)
    const member = { ...person, role: workspace.role, shared: workspace.members > 1 }
    return runAtEdge(ownerCall(env.AGENTS.getByName(workspace.id), caller, member, call, { ref }))
  }
}

/**
 * `/mcp` (ADR 0086): one server for every caller, its tools those the caller's scopes reach, each an owner API call as
 * that caller to an agent: a key's own workspace's (ADR 0089), or for an OAuth client the workspace the call names
 * among those its consent reaches (ADR 0097).
 */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const admitted = await admit(request, env)
  if (admitted === undefined) return challengeOf(env.APP_URL)
  const { caller, token } = admitted
  const call = callerOf(admitted, env, refOf(request))
  const reach = admitted.kind === 'client' ? admitted.reach : undefined
  const handler = createMcpHandler(() => mcpServer(caller.scopes, call, reach), {
    route: '/mcp',
    // The canonical host is configuration, not the request's Host/Origin. This keeps custom domains valid while
    // retaining the SDK's DNS-rebinding protection; the Worker redirects alternate hosts before reaching here.
    ...inboundHosts(env.APP_URL),
  })
  return handler.fetch(request, {
    authInfo: {
      token,
      clientId: callerId(caller),
      scopes: [...caller.scopes],
      ...(admitted.kind === 'client' ? { expiresAt: admitted.expiresAt } : {}),
    },
  })
}
