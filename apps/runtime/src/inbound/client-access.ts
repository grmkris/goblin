import type { WorkspaceView } from '@goblin/contracts'
import { credentialOf } from '../auth/api-keys.ts'
import { type GrantRecord, type WorkspaceCoverage, coveragesOf } from '../auth/grants.ts'
import { clientName, verifyClientToken } from '../auth/index.ts'
import { reachedBy } from '../auth/workspaces.ts'
import type { RuntimeEnv } from '../env.ts'
import { type Credential, type Member, memberName } from '../http/api/principal.ts'
import { NotFound, Unauthenticated } from '../http/errors.ts'
import type { CallerReach } from './mcp-server.ts'

/**
 * An OAuth client's token, admitted (ADRs 0024, 0097, 0114): the client, the grant its person gave it, what that grant
 * reaches in each workspace, the person, and the workspaces it reaches now that the person belongs to. `/mcp` and the
 * edge (ADR 0116) both admit a token this way.
 */
export interface ClientAccess {
  readonly clientId: string
  readonly name: string
  readonly grant: GrantRecord
  readonly coverage: ReadonlyMap<string, WorkspaceCoverage>
  readonly person: { readonly user: string; readonly name: string }
  readonly reach: CallerReach
  readonly expiresAt: number
}

/**
 * The client a token is (`verifyClientToken`) and what it reaches now. It rejects with that check's `Unauthenticated`,
 * or with one for a token whose person is gone.
 */
export const clientAccess = async (env: RuntimeEnv, token: string): Promise<ClientAccess> => {
  const principal = await verifyClientToken(token, env)
  const [name, reached, coverage, person] = await Promise.all([
    clientName(principal.clientId, env),
    reachedBy(env.AUTH_DB, principal.subject, principal.clientId),
    coveragesOf(env.AUTH_DB, principal.grant),
    env.AUTH_DB.prepare('SELECT name, email FROM user WHERE id = ?')
      .bind(principal.subject)
      .first<{ name: string; email: string }>(),
  ])
  if (person === null) throw new Unauthenticated({ reason: 'token' })
  const workspaces = reached?.workspaces ?? []
  const all = reached?.all ?? false
  return {
    clientId: principal.clientId,
    name: name ?? 'an MCP client',
    grant: principal.grant,
    coverage,
    person: { user: principal.subject, name: memberName(person) },
    // A client given exactly one workspace never names it; "all" always does, so joining another never changes what
    // a call without a workspace means.
    reach: { all, workspaces, named: all || workspaces.length !== 1 },
    expiresAt: principal.expiresAt,
  }
}

/** The credential a client's grant makes in `workspace`, and its person as a member there with their role (ADR 0114). */
export const clientIn = (
  access: ClientAccess,
  workspace: WorkspaceView,
): { readonly credential: Credential; readonly member: Member } => {
  const ws = access.coverage.get(workspace.id) ?? {
    workspace: workspace.id,
    topics: 'all',
    personas: 'all',
    connections: 'all',
    generation: 0,
  }
  return {
    credential: credentialOf(access.grant, { id: access.clientId, name: access.name }, ws),
    member: { ...access.person, role: workspace.role, shared: workspace.members > 1 },
  }
}

/**
 * A client's token on a workspace's path (ADR 0116): the workspace at `slug` among those it reaches now, the credential
 * its grant makes there and its person as a member of it. `NotFound` `workspace` for a slug it does not reach, as a
 * session that is no member gets.
 */
export const clientAt = async (
  env: RuntimeEnv,
  token: string,
  slug: string,
): Promise<{ readonly workspace: WorkspaceView; readonly credential: Credential; readonly member: Member }> => {
  const access = await clientAccess(env, token)
  const workspace = access.reach.workspaces.find((each) => each.slug === slug)
  if (workspace === undefined) throw new NotFound({ what: 'workspace' })
  return { workspace, ...clientIn(access, workspace) }
}
