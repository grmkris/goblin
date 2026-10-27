import { createMcpHandler } from 'agents/mcp/server'
import { challengeOf } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { refOf, runAtEdge } from '../http/api/edge.ts'
import { Unauthenticated } from '../http/errors.ts'
import { type TokenAccess, callIn, reachedFor, tokenAccess } from './client-access.ts'
import { ownerCall } from './client.ts'
import { mcpServer } from './mcp-server.ts'
import type { OwnerCaller, Power } from './tools.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * Who a bearer on /mcp is, and which agents it reaches (ADR 0125): an OAuth client those of the workspaces its grant
 * reaches now (ADRs 0097, 0114), acting for its person as a member of each, with the credential its grant makes in
 * each; an installed app those it is installed in (ADR 0118), with each installation's credential and no person.
 */
type Admitted = { readonly token: string } & TokenAccess

/** No bearer at all, or one that was presented and refused: the challenge says which (RFC 6750 §3.1). */
type Challenged = { readonly kind: 'challenge'; readonly invalidToken: boolean }

/**
 * An OAuth client a person consented to (ADR 0024) with the grant they gave it and the workspaces it reaches now (ADRs
 * 0097, 0114), or an installed app (ADR 0118). A token that does not admit, or no bearer at all, is answered with the
 * sign-in challenge, naming `invalid_token` when one was presented (an old server key's included, ADR 0125).
 */
const admit = async (request: Request, env: RuntimeEnv): Promise<Admitted | Challenged> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return { kind: 'challenge', invalidToken: false }
  const token = header.slice('Bearer '.length)
  try {
    return { token, ...(await tokenAccess(env, token)) }
  } catch (failure) {
    // expected: a token that does not admit is answered with the sign-in challenge, as a missing one is.
    if (failure instanceof Unauthenticated) return { kind: 'challenge', invalidToken: true }
    throw failure
  }
}

/**
 * How each tool call reaches its agent: the workspace a client's or an app's call names, with the credential its grant
 * makes there (and a client's person's role in it).
 */
const callerOf =
  (admitted: Admitted, env: RuntimeEnv, ref: string): OwnerCaller =>
  async (call, named) => {
    const workspace = reachedFor(admitted, named, env.APP_URL)
    const { credential, member } = callIn(admitted, workspace)
    return runAtEdge(ownerCall(env.AGENTS.getByName(workspace.id), credential, member, call, { ref }))
  }

/**
 * The level and extras a bearer's tools are listed by: a client's grant's; for an app, the most its installations hold
 * (ADR 0118), since each call goes as one installation's credential and owner admission holds it to that grant.
 */
const powerOf = (admitted: Admitted): Power => {
  if (admitted.kind === 'client') return admitted.grant
  const grants = [...admitted.installations.values()].map((each) => each.grant)
  const order = ['read', 'write', 'manage'] as const
  const level = order[Math.max(0, ...grants.map((grant) => order.indexOf(grant.level)))] ?? 'read'
  return { level, extras: [...new Set(grants.flatMap((grant) => grant.extras))] }
}

/**
 * `/mcp` (ADRs 0086, 0114): one server for every credential, its tools those its grant's level and extras reach, each
 * an owner API call as that credential to the agent of the workspace the call names among those it reaches (ADRs 0097,
 * 0118).
 */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const admitted = await admit(request, env)
  if (admitted.kind === 'challenge') return challengeOf(env.APP_URL, admitted)
  const { token } = admitted
  const power = powerOf(admitted)
  const grantId = admitted.kind === 'client' ? admitted.grant.id : `app:${admitted.clientId}`
  const call = callerOf(admitted, env, refOf(request))
  const handler = createMcpHandler(() => mcpServer(power, call, admitted.reach), {
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
      expiresAt: admitted.expiresAt,
    },
  })
}
