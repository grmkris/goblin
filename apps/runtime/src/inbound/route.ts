import { createMcpHandler } from 'agents/mcp/server'
import { verifyKey } from '../auth/api-keys.ts'
import { challengeOf } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { refOf, runAtEdge } from '../http/api/edge.ts'
import { type Credential, bearerKey } from '../http/api/principal.ts'
import { Unauthenticated } from '../http/errors.ts'
import { type TokenAccess, callIn, tokenAccess } from './client-access.ts'
import { ownerCall } from './client.ts'
import { mcpServer } from './mcp-server.ts'
import { workspaceFor } from './reach.ts'
import type { OwnerCaller, Power } from './tools.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * Who a bearer on /mcp is, and which agents it reaches: a key its own workspace's (ADR 0089), as its credential; an
 * OAuth client those of the workspaces its grant reaches now (ADRs 0097, 0114), acting for its person as a member of
 * each, with the credential its grant makes in each; an installed app those it is installed in (ADR 0118), with each
 * installation's credential and no person.
 */
type Admitted =
  | { readonly kind: 'key'; readonly workspaceId: string; readonly credential: Credential; readonly token: string }
  | ({ readonly token: string } & TokenAccess)

/**
 * A server's API key (ADR 0081), an OAuth client a person consented to (ADR 0024) with the grant they gave it and the
 * workspaces it reaches now (ADRs 0097, 0114), or an installed app (ADR 0118). A key that does not admit rejects with its
 * `Unauthenticated`, which
 * the Worker answers in the envelope `/api` uses: there is nothing to sign in to. An OAuth token that does not verify,
 * or no bearer at all, is answered with the sign-in challenge.
 */
const admit = async (request: Request, env: RuntimeEnv): Promise<Admitted | undefined> => {
  const key = bearerKey(request)
  if (key !== undefined) {
    const { workspaceId, credential } = await verifyKey(env, key)
    return { kind: 'key', workspaceId, credential, token: key }
  }
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length)
  try {
    return { token, ...(await tokenAccess(env, token)) }
  } catch (failure) {
    // expected: a token that does not admit is answered with the sign-in challenge, as a missing one is.
    if (failure instanceof Unauthenticated) return undefined
    throw failure
  }
}

/**
 * How each tool call reaches its agent: a key's own workspace with its credential, or the workspace a client's or an
 * app's call names, with the credential its grant makes there (and a client's person's role in it).
 */
const callerOf = (admitted: Admitted, env: RuntimeEnv, ref: string): OwnerCaller => {
  if (admitted.kind === 'key') {
    const agent = env.AGENTS.getByName(admitted.workspaceId)
    return (call) => runAtEdge(ownerCall(agent, admitted.credential, undefined, call, { ref }))
  }
  return async (call, named) => {
    const workspace = workspaceFor(admitted.reach, named)
    const { credential, member } = callIn(admitted, workspace)
    return runAtEdge(ownerCall(env.AGENTS.getByName(workspace.id), credential, member, call, { ref }))
  }
}

/**
 * The level and extras a bearer's tools are listed by: a key's or a client's grant's; for an app, the most its
 * installations hold (ADR 0118), since each call goes as one installation's credential and owner admission holds it to
 * that grant.
 */
const powerOf = (admitted: Admitted): Power => {
  if (admitted.kind === 'key') return admitted.credential
  if (admitted.kind === 'client') return admitted.grant
  const grants = [...admitted.installations.values()].map((each) => each.grant)
  const order = ['read', 'write', 'manage'] as const
  const level = order[Math.max(0, ...grants.map((grant) => order.indexOf(grant.level)))] ?? 'read'
  return { level, extras: [...new Set(grants.flatMap((grant) => grant.extras))] }
}

/**
 * `/mcp` (ADRs 0086, 0114): one server for every credential, its tools those its grant's level and extras reach, each
 * an owner API call as that credential to an agent: a key's own workspace's (ADR 0089), or for an OAuth client the
 * workspace the call names among those its grant reaches (ADR 0097).
 */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const admitted = await admit(request, env)
  if (admitted === undefined) return challengeOf(env.APP_URL)
  const { token } = admitted
  const power = powerOf(admitted)
  const grantId =
    admitted.kind === 'key'
      ? admitted.credential.grantId
      : admitted.kind === 'client'
        ? admitted.grant.id
        : `app:${admitted.clientId}`
  const call = callerOf(admitted, env, refOf(request))
  const reach = admitted.kind === 'key' ? undefined : admitted.reach
  const handler = createMcpHandler(() => mcpServer(power, call, reach), {
    route: '/mcp',
    // The canonical host is configuration, not the request's Host/Origin. This keeps custom domains valid while
    // retaining the SDK's DNS-rebinding protection; the Worker redirects alternate hosts before reaching here.
    ...inboundHosts(env.APP_URL),
  })
  return handler.fetch(request, {
    authInfo: {
      token,
      clientId: `grant:${grantId}`,
      scopes: ['goblin'],
      ...(admitted.kind === 'key' ? {} : { expiresAt: admitted.expiresAt }),
    },
  })
}
