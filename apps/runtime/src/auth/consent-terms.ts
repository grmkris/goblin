import {
  type AccessSummary,
  type ConsentTerms,
  GRANT_SPEC,
  type GoblinReach,
  type GrantTerms,
  type ReachKind,
  type ReachOption,
  type WorkspaceView,
  defaultTerms,
  presetFor,
  reachId,
  widenUrl,
} from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { NotFound } from '../http/errors.ts'
import { clientName } from './service.ts'
import {
  type GrantRecord,
  grantById,
  grantOfClient,
  historyOf,
  mayApprove,
  setClientTerms,
  setTerms,
  termsOf,
} from './grants.ts'
import { type Person, workspacesOf } from './workspaces.ts'

/**
 * What the consent, widening and Settings pages read and write of a grant (ADR 0114), for the person who approves it:
 * the spec's levels and extras, what may be reached (one option per workspace, its Topics, Personas and connections as
 * groups), the default chain's terms and a live grant's own. Answered by the Worker from the auth D1 alone: a group
 * lists only what the grant lists now, and the page reads a workspace's Topics, Personas and connections from that
 * workspace's own API to offer more.
 */

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString())

/** `grant`'s summary as `GET /api/access` and the pages show it: its terms, ids, end and widening link. */
export const summaryOf = (appUrl: string, grant: GrantRecord, terms: GrantTerms): AccessSummary => ({
  ...terms,
  grantId: grant.id,
  kind: grant.kind,
  clientId: grant.clientId,
  expiresAt: iso(grant.expiresAt),
  widenUrl: widenUrl(appUrl, grant.id, {}),
})

const GROUPS = [
  ['topic', 'Topics', 'topics'],
  ['persona', 'Personas', 'personas'],
  ['connection', 'Connections', 'connections'],
] as const satisfies readonly (readonly [ReachKind, string, string])[]

/** What may be reached in each of `workspaces`, with what `reach` lists there now. */
const reachOptions = (workspaces: readonly WorkspaceView[], reach: GoblinReach | undefined): ReachOption[] =>
  workspaces.map((workspace) => {
    const named = reach?.each.find((each) => each.workspace === workspace.id)
    return {
      id: workspace.id,
      label: workspace.name,
      description: workspace.slug,
      children: GROUPS.map(([kind, label, field]) => {
        const list = named?.[field]
        return {
          id: `${workspace.id}/${kind}`,
          label,
          selectable: false,
          children:
            list?.kind === 'list' ? list.ids.map((id) => ({ id: reachId(workspace.id, kind, id), label: id })) : [],
        }
      }),
    }
  })

/** The grant editor's spec over `workspaces`: the levels and extras, and what may be reached in each. */
export const consentSpec = (
  workspaces: readonly WorkspaceView[],
  reach: GoblinReach | undefined,
): ConsentTerms['spec'] => ({
  levels: GRANT_SPEC.levels,
  extras: GRANT_SPEC.extras,
  reachOptions: reachOptions(workspaces, reach),
})

/**
 * What the consent page shows `person` for MCP client `clientId`: the default chain's terms (the same client's last,
 * else their latest grant's without risky extras, else the preset over all of their workspaces, named as the client
 * registered) and, once it has a live grant, that grant's terms, summary and id. An unregistered client is `NotFound`.
 */
export const clientTerms = async (env: RuntimeEnv, person: Person, clientId: string): Promise<ConsentTerms> => {
  const db = env.AUTH_DB
  const registered = await db
    .prepare('SELECT "clientId" FROM "oauthClient" WHERE "clientId" = ?')
    .bind(clientId)
    .first()
  if (registered === null) throw new NotFound({ what: 'client' })
  const name = (await clientName(clientId, env)) ?? 'MCP client'
  const [same, latest, grant, workspaces] = await Promise.all([
    historyOf(db, person.id, clientId),
    historyOf(db, person.id),
    grantOfClient(db, clientId, person.id),
    workspacesOf(db, person, new Date()),
  ])
  const live = grant !== undefined && grant.revokedAt === null ? grant : undefined
  const current = live === undefined ? null : await termsOf(db, live)
  const defaults = defaultTerms(
    { ...GRANT_SPEC, preset: presetFor(name, 'all') },
    {
      ...(same === undefined ? {} : { sameClient: same }),
      ...(latest === undefined ? {} : { latest: { ...latest, name } }),
    },
  )
  return {
    spec: consentSpec(workspaces, current?.reach ?? defaults.reach),
    defaults,
    current,
    ...(live === undefined || current === null
      ? {}
      : { summary: summaryOf(env.APP_URL, live, current), grantId: live.id }),
  }
}

/** Grant `grantId`, when `person` may approve it (`mayApprove`); `NotFound` otherwise, so asking reveals none. */
const approvable = async (env: RuntimeEnv, person: Person, grantId: string): Promise<GrantRecord> => {
  const grant = await grantById(env.AUTH_DB, grantId)
  if (grant === undefined || !(await mayApprove(env.AUTH_DB, person.id, grant))) throw new NotFound({ what: 'grant' })
  return grant
}

/**
 * What the widening page shows `person` for grant `grantId`: its terms (as the defaults too), summary and id, and what
 * may be chosen: an installation's workspace for its own, the person's workspaces for a client's.
 */
export const grantTerms = async (env: RuntimeEnv, person: Person, grantId: string): Promise<ConsentTerms> => {
  const grant = await approvable(env, person, grantId)
  const current = await termsOf(env.AUTH_DB, grant)
  const mine = await workspacesOf(env.AUTH_DB, person, new Date())
  const named = new Set(current.reach.each.map((each) => each.workspace))
  const workspaces = grant.kind === 'client' ? mine : mine.filter((workspace) => named.has(workspace.id))
  return {
    spec: consentSpec(workspaces, current.reach),
    defaults: current,
    current,
    summary: summaryOf(env.APP_URL, grant, current),
    grantId: grant.id,
  }
}

/** A grant's terms before and after a change, and when it ends now. */
export interface TermsChange {
  readonly grant: GrantRecord
  readonly before: GrantTerms | undefined
  readonly after: GrantTerms
  readonly expiresAt: string | null
}

/** `terms` as grant `grantId`'s from now on, approved by `person` (widened or narrowed). */
export const widenGrant = async (
  env: RuntimeEnv,
  person: Person,
  grantId: string,
  terms: GrantTerms,
): Promise<TermsChange> => {
  const grant = await approvable(env, person, grantId)
  const before = await termsOf(env.AUTH_DB, grant)
  // Widening changes what a grant may do, never what it is called: an installation's name is its app's own.
  const after = await setTerms(env.AUTH_DB, person.id, grant, { ...terms, name: before.name }, Date.now())
  const saved = await grantById(env.AUTH_DB, grantId)
  return { grant: saved ?? grant, before, after, expiresAt: iso(saved?.expiresAt ?? null) }
}

/** `terms` as the grant `person` gives MCP client `clientId`, before its consent or later from Settings. */
export const setClientGrant = async (
  env: RuntimeEnv,
  person: Person,
  clientId: string,
  terms: GrantTerms,
): Promise<TermsChange> => {
  const existing = await grantOfClient(env.AUTH_DB, clientId, person.id)
  const before =
    existing === undefined || existing.revokedAt !== null ? undefined : await termsOf(env.AUTH_DB, existing)
  const { grant, terms: after } = await setClientTerms(env.AUTH_DB, person.id, clientId, terms, Date.now())
  return { grant, before, after, expiresAt: iso(grant.expiresAt) }
}

/**
 * The workspaces whose Topics `after` reaches less of than `before` did: dropped, all made a list, or ids taken off a
 * list. A grant's published Events leases there end (ADR 0112), so a lease never outlives the reach it was made under.
 */
export const narrowedTopics = (before: GoblinReach | undefined, after: GoblinReach): readonly string[] =>
  (before?.each ?? []).flatMap((was) => {
    const now = after.each.find((each) => each.workspace === was.workspace)
    if (now === undefined) return after.workspaces === 'all' ? [] : [was.workspace]
    if (was.topics.kind === 'all') return now.topics.kind === 'all' ? [] : [was.workspace]
    const kept = now.topics.kind === 'all' ? undefined : new Set(now.topics.ids)
    return kept !== undefined && was.topics.ids.some((id) => !kept.has(id)) ? [was.workspace] : []
  })
