import { createMcpHandler } from 'agents/mcp/server'
import type { WorkspaceView } from '@goblin/contracts'
import { credentialOf, verifyKey } from '../auth/api-keys.ts'
import { type GrantRecord, type WorkspaceCoverage, coveragesOf } from '../auth/grants.ts'
import { challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import { reachedBy } from '../auth/workspaces.ts'
import type { RuntimeEnv } from '../env.ts'
import { refOf, runAtEdge } from '../http/api/edge.ts'
import { type Credential, bearerKey, memberName } from '../http/api/principal.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { ownerCall } from './client.ts'
import { type CallerReach, mcpServer } from './mcp-server.ts'
import type { OwnerCaller } from './tools.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/**
 * Who a bearer on /mcp is, and which agents it reaches: a key its own workspace's (ADR 0089), as its credential; an
 * OAuth client those of the workspaces its grant reaches now (ADRs 0097, 0114), acting for its person as a member of
 * each, with the credential its grant makes in each.
 */
type Admitted =
  | { readonly kind: 'key'; readonly workspaceId: string; readonly credential: Credential; readonly token: string }
  | {
      readonly kind: 'client'
      readonly clientId: string
      readonly name: string
      readonly grant: GrantRecord
      readonly coverage: ReadonlyMap<string, WorkspaceCoverage>
      readonly person: { readonly user: string; readonly name: string }
      readonly reach: CallerReach
      readonly token: string
      readonly expiresAt: number
    }

/**
 * A server's API key (ADR 0081), or an OAuth client a person consented to (ADR 0024) with the grant they gave it and
 * the workspaces it reaches now (ADRs 0097, 0114). A key that does not admit rejects with its `Unauthenticated`, which
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
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    // expected: a token that does not verify is answered with the sign-in challenge, as a missing one is.
    return undefined
  }
  const [name, reached, coverage, person] = await Promise.all([
    clientName(principal.clientId, env),
    reachedBy(env.AUTH_DB, principal.subject, principal.clientId),
    coveragesOf(env.AUTH_DB, principal.grant),
    env.AUTH_DB.prepare('SELECT name, email FROM user WHERE id = ?')
      .bind(principal.subject)
      .first<{ name: string; email: string }>(),
  ])
  if (person === null) return undefined
  const workspaces = reached?.workspaces ?? []
  const all = reached?.all ?? false
  return {
    kind: 'client',
    clientId: principal.clientId,
    name: name ?? 'an MCP client',
    grant: principal.grant,
    coverage,
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
  // An id first: a slug is its admins' to choose, so one may look like another workspace's id.
  const chosen =
    reach.workspaces.find((workspace) => workspace.id === named) ??
    reach.workspaces.find((workspace) => workspace.slug === named)
  if (chosen === undefined) throw new NotFound({ what: 'workspace' })
  return chosen
}

/**
 * How each tool call reaches its agent: a key's own workspace with its credential, or the client's workspace the call
 * names, with the credential its grant makes there and its person's role in it.
 */
const callerOf = (admitted: Admitted, env: RuntimeEnv, ref: string): OwnerCaller => {
  if (admitted.kind === 'key') {
    const agent = env.AGENTS.getByName(admitted.workspaceId)
    return (call) => runAtEdge(ownerCall(agent, admitted.credential, undefined, call, { ref }))
  }
  const { grant, coverage, person, reach } = admitted
  return async (call, named) => {
    const workspace = workspaceFor(reach, named)
    const ws = coverage.get(workspace.id) ?? {
      workspace: workspace.id,
      topics: 'all',
      personas: 'all',
      connections: 'all',
      generation: 0,
    }
    const credential = credentialOf(grant, { id: admitted.clientId, name: admitted.name }, ws)
    const member = { ...person, role: workspace.role, shared: workspace.members > 1 }
    return runAtEdge(ownerCall(env.AGENTS.getByName(workspace.id), credential, member, call, { ref }))
  }
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
  const power = admitted.kind === 'key' ? admitted.credential : admitted.grant
  const grantId = admitted.kind === 'key' ? admitted.credential.grantId : admitted.grant.id
  const call = callerOf(admitted, env, refOf(request))
  const reach = admitted.kind === 'client' ? admitted.reach : undefined
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
      ...(admitted.kind === 'client' ? { expiresAt: admitted.expiresAt } : {}),
    },
  })
}
