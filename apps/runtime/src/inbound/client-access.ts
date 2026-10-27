import type { WorkspaceView } from '@goblin/contracts'
import { type AccessInsufficient, accessInsufficient } from '@goblin/contracts/api'
import { type GrantRecord, type WorkspaceCoverage, coveragesOf, credentialOf } from '../auth/grants.ts'
import { clientName, verifyAccessToken } from '../auth/index.ts'
import { type AppInstallation, appInstallations } from '../auth/installs.ts'
import { type ReachedWorkspace, reachedBy } from '../auth/workspaces.ts'
import type { RuntimeEnv } from '../env.ts'
import { type Credential, type Member, memberName } from '../http/api/principal.ts'
import { NotFound, Unauthenticated } from '../http/errors.ts'
import type { CallerReach } from './mcp-server.ts'
import { workspaceFor } from './reach.ts'

/**
 * An OAuth client's token, admitted (ADRs 0024, 0097, 0114): the client, the grant its person gave it, what that grant
 * reaches in each workspace, the person, and the workspaces it reaches now that the person belongs to.
 */
export interface ClientAccess {
  readonly kind: 'client'
  readonly clientId: string
  readonly name: string
  readonly grant: GrantRecord
  readonly coverage: ReadonlyMap<string, WorkspaceCoverage>
  readonly person: { readonly user: string; readonly name: string }
  readonly reach: CallerReach<WorkspaceView>
  /** The person's other workspaces, which its grant does not reach: a call naming one may ask to widen (ADR 0127). */
  readonly outside: readonly WorkspaceView[]
  readonly expiresAt: number
}

/**
 * An installed app's token, admitted (ADR 0118): the app, its live installations by workspace (each with its own
 * grant), and those workspaces. It acts for no one.
 */
export interface AppAccess {
  readonly kind: 'app'
  readonly clientId: string
  readonly name: string
  readonly installations: ReadonlyMap<string, AppInstallation>
  readonly reach: CallerReach
  readonly expiresAt: number
}

/** A token as `/mcp` and the edge (ADR 0116) admit it: a client acting for a person, or an installed app. */
export type TokenAccess = ClientAccess | AppAccess

/** A reach of `workspaces`: one never named, several (or "all") always named, so joining another never changes a call. */
const reachOf = <W extends ReachedWorkspace>(all: boolean, workspaces: readonly W[]): CallerReach<W> => ({
  all,
  workspaces,
  named: all || workspaces.length !== 1,
})

/**
 * Who a token is (`verifyAccessToken`) and what it reaches now. It rejects with that check's `Unauthenticated`, or with
 * one for a client token whose person is gone.
 */
export const tokenAccess = async (env: RuntimeEnv, token: string): Promise<TokenAccess> => {
  const verified = await verifyAccessToken(token, env)
  const name = (await clientName(verified.clientId, env)) ?? (verified.kind === 'app' ? 'an app' : 'an MCP client')
  if (verified.kind === 'app') {
    const installations = await appInstallations(env, verified.clientId)
    return {
      kind: 'app',
      clientId: verified.clientId,
      name,
      installations: new Map(installations.map((each) => [each.workspace.id, each])),
      reach: reachOf(
        false,
        installations.map((each) => each.workspace),
      ),
      expiresAt: verified.expiresAt,
    }
  }
  const [reached, coverage, person] = await Promise.all([
    reachedBy(env.AUTH_DB, verified.subject, verified.clientId),
    coveragesOf(env.AUTH_DB, verified.grant),
    env.AUTH_DB.prepare('SELECT name, email FROM user WHERE id = ?')
      .bind(verified.subject)
      .first<{ name: string; email: string }>(),
  ])
  if (person === null) throw new Unauthenticated({ reason: 'token' })
  return {
    kind: 'client',
    clientId: verified.clientId,
    name,
    grant: verified.grant,
    coverage,
    person: { user: verified.subject, name: memberName(person) },
    reach: reachOf(reached?.all ?? false, reached?.workspaces ?? []),
    outside: reached?.outside ?? [],
    expiresAt: verified.expiresAt,
  }
}

/** What a token's call in one workspace carries: the credential its grant makes there, and the person it acts for. */
export interface TokenCall {
  readonly credential: Credential
  readonly member?: Member
}

/** A client's person's role in `workspaceId`, one of its reach's; `NotFound` for any other. */
const roleIn = (access: ClientAccess, workspaceId: string) => {
  const view = access.reach.workspaces.find((each) => each.id === workspaceId)
  if (view === undefined) throw new NotFound({ what: 'workspace' })
  return view.role
}

/**
 * The credential a token's grant makes in `workspace` (ADR 0114): a client's, with its person as a member there with
 * their role; an app's, its installation's there, with no member (ADR 0118). `workspace` is one of its reach's.
 */
export const callIn = (access: TokenAccess, workspace: ReachedWorkspace): TokenCall => {
  const identity = { id: access.clientId, name: access.name }
  if (access.kind === 'app') {
    const installation = access.installations.get(workspace.id)
    if (installation === undefined) throw new NotFound({ what: 'workspace' })
    return { credential: credentialOf(installation.grant, identity, installation.coverage) }
  }
  const ws = access.coverage.get(workspace.id) ?? {
    workspace: workspace.id,
    topics: 'all',
    personas: 'all',
    connections: 'all',
    generation: 0,
  }
  return {
    credential: credentialOf(access.grant, identity, ws),
    member: { ...access.person, role: roleIn(access, workspace.id), shared: workspace.members > 1 },
  }
}

/**
 * The refusal for a workspace a token does not reach, which `pick` finds among a client's person's other workspaces:
 * for one they belong to, `AccessInsufficient` with the link to widen the grant by that workspace, which they may
 * approve (ADR 0127); for any other workspace, and for an app, `NotFound` `workspace`, as a session that is no member
 * gets.
 */
const outsideReach = (
  access: TokenAccess,
  pick: (outside: readonly WorkspaceView[]) => WorkspaceView | undefined,
  appUrl: string,
): AccessInsufficient | NotFound => {
  if (access.kind !== 'client') return new NotFound({ what: 'workspace' })
  const member = pick(access.outside)
  return member === undefined
    ? new NotFound({ what: 'workspace' })
    : accessInsufficient(appUrl, access.grant.id, { reachId: member.id })
}

/**
 * The workspace a token's call names on `/mcp` (by id, then slug) among those it reaches, or its only one when it names
 * none (`workspaceFor`); a named one outside its reach is refused as `outsideReach` says.
 */
export const reachedFor = (access: TokenAccess, named: string | undefined, appUrl: string): ReachedWorkspace => {
  try {
    return workspaceFor<ReachedWorkspace>(access.reach, named)
  } catch (failure) {
    if (!(failure instanceof NotFound) || named === undefined) throw failure
    // An id first, as `workspaceFor` reads one: a slug is its admins' to choose.
    const pick = (outside: readonly WorkspaceView[]) =>
      outside.find((each) => each.id === named) ?? outside.find((each) => each.slug === named)
    throw outsideReach(access, pick, appUrl)
  }
}

/**
 * A token on a workspace's path (ADRs 0116, 0118): the workspace at `slug` among those it reaches now, and its call
 * there. A client's person's own workspace outside its grant is `AccessInsufficient` with its widening link (ADR
 * 0127); any other slug is `NotFound` `workspace`, as a session that is no member gets.
 */
export const tokenAt = async (
  env: RuntimeEnv,
  token: string,
  slug: string,
): Promise<TokenCall & { readonly workspace: ReachedWorkspace }> => {
  const access = await tokenAccess(env, token)
  const workspace = access.reach.workspaces.find((each) => each.slug === slug)
  if (workspace === undefined)
    throw outsideReach(access, (outside) => outside.find((each) => each.slug === slug), env.APP_URL)
  return { workspace, ...callIn(access, workspace) }
}
