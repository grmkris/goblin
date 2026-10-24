/**
 * One grant for every credential: what a server's API key, or an OAuth client acting for a person, may do in goblin.
 * Its terms are level × reach × extras × lifetime, as in myapps ADR 0015. A refused call answers what is missing and
 * a widening link (`widenUrl`) where the owner can allow it. People keep their workspace roles (`ROLE_POWER`); an OAuth
 * client's power is its person's role and its grant together. Everything here is pure: storage and enforcement live in
 * the runtime.
 *
 * Adapted from grmkris/myapps `packages/grants/src/terms.ts` at b8014322 (MIT, same author). What changed: goblin's own
 * level, extra and lifetime literals and its nested reach (workspaces, then Topics, Personas and connections in each,
 * and the MCP origins a credential may bring); one spec instead of a generic one per app, so `allowsReach` is required
 * and the flat `Reach` fallback is gone; `expiresAt` takes and answers epoch milliseconds; the refusal is the
 * `AccessInsufficient` error class (`api/errors.ts`) with fixed copy rather than text built from the missing terms;
 * `ROLE_POWER`, `Need`, `presetFor`, `reachId` and `reaches` are goblin's own. Its tests are ported in `grants.test.ts`.
 */
import * as Schema from 'effect/Schema'
import type { WorkspaceRole } from './account.ts'
import { NonEmptyString, WorkspaceId } from './ids.ts'
import { KeyOrigin } from './origins.ts'

/**
 * How much a credential may do within its reach, least first. `read` sees; `write` also sends, creates Topics and
 * threads, answers questions and stops runs; `manage` also creates, edits and archives Personas and edits a Topic's
 * settings.
 */
export const Level = Schema.Literals(['read', 'write', 'manage'])
export type Level = typeof Level.Type

/**
 * Named powers beside the level: `setup` (what setups, Sources and servers use, and with `manage` the connections
 * themselves, ADR 0117; risky), `routines` (risky), `inspect`
 * (run records within reach) and `keys` (risky, and only an owner may grant it; vocabulary only for now, it opens
 * nothing yet).
 */
export const Extra = Schema.Literals(['setup', 'routines', 'inspect', 'keys'])
export type Extra = typeof Extra.Type

/** How long an approval lasts: until revoked (`never`, the default), or 1, 7, 30, 90 or 365 days. */
export const Lifetime = Schema.Literals(['never', '1d', '7d', '30d', '90d', '365d'])
export type Lifetime = typeof Lifetime.Type

const DAYS: Readonly<Record<Exclude<Lifetime, 'never'>, number>> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
}
const DAY_MS = 86_400_000

/** When a grant approved at `now` (epoch milliseconds, the caller's clock) ends; `null` until revoked. */
export const expiresAt = (lifetime: Lifetime, now: number): number | null =>
  lifetime === 'never' ? null : now + DAYS[lifetime] * DAY_MS

/** The most ids one reach list holds, and the most workspaces one grant names. */
const MAX_REACH_IDS = 10_000
const MAX_WORKSPACES = 200

/** All of a kind, or only the listed ones. A credential's list grows with what it creates; there is no "own". */
export type ReachList<T> = { readonly kind: 'all' } | { readonly kind: 'list'; readonly ids: readonly T[] }
export const ReachList = <S extends Schema.Top>(id: S) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('all') }),
    Schema.Struct({ kind: Schema.Literal('list'), ids: Schema.Array(id).check(Schema.isMaxLength(MAX_REACH_IDS)) }),
  ])

/** A Topic's or a Persona's id as a reach names it: the number in decimal, 1 to 999999999. */
const NumberedId = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,8}$/u))
/** An MCP connection's id. */
const ConnectionId = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/** What a reach id names inside a workspace. */
export const ReachKind = Schema.Literals(['topic', 'persona', 'connection'])
export type ReachKind = typeof ReachKind.Type

/** What a grant reaches in one workspace: its Topics, its Personas and its MCP connections. */
export const WorkspaceReach = Schema.Struct({
  workspace: WorkspaceId,
  topics: ReachList(NumberedId),
  personas: ReachList(NumberedId),
  connections: ReachList(ConnectionId),
})
export type WorkspaceReach = typeof WorkspaceReach.Type

/**
 * A grant's whole reach. `workspaces: 'all'` reaches every workspace the person is a member of at each call, ones they
 * join later included, and one without an entry in `each` with everything in it; `'list'` reaches only the workspaces
 * in `each`. A key's is always the list of its one workspace. `origins` are the MCP servers its threads may bring
 * (ADR 0091), each with exactly the tools they may call there.
 */
export const GoblinReach = Schema.Struct({
  workspaces: Schema.Literals(['all', 'list']),
  each: Schema.Array(WorkspaceReach).check(
    Schema.isMaxLength(MAX_WORKSPACES),
    Schema.makeFilter((each) => new Set(each.map((reach) => reach.workspace)).size === each.length),
  ),
  origins: Schema.Array(KeyOrigin),
})
export type GoblinReach = typeof GoblinReach.Type

const FIELD = { topic: 'topics', persona: 'personas', connection: 'connections' } as const satisfies Record<
  ReachKind,
  keyof WorkspaceReach
>

/** Whether `reach` reaches `workspace` at all. */
export const reachesWorkspace = (reach: GoblinReach, workspace: string): boolean =>
  reach.workspaces === 'all' || reach.each.some((each) => each.workspace === workspace)

/** Whether `reach` reaches the `kind` `id` (a Topic's or a Persona's number in decimal, a connection's id) in `workspace`. */
export const reaches = (reach: GoblinReach, workspace: string, kind: ReachKind, id: string): boolean => {
  const each = reach.each.find((entry) => entry.workspace === workspace)
  if (each === undefined) return reach.workspaces === 'all'
  const list = each[FIELD[kind]]
  return list.kind === 'all' || list.ids.includes(id)
}

/** A reach item's id in a refusal and a widening link: `<workspace>/<kind>/<id>`. A bare workspace id names the workspace. */
export const reachId = (workspace: string, kind: ReachKind, id: string): string => `${workspace}/${kind}/${id}`

const isReachKind = Schema.is(ReachKind)

/** Whether `reach` holds the item `id` names (`reachId`); anything that does not parse fails closed. */
const allowsReach = (reach: GoblinReach, id: string): boolean => {
  const [workspace = '', kind, item, ...rest] = id.split('/')
  if (workspace === '') return false
  if (kind === undefined) return reachesWorkspace(reach, workspace)
  return (
    item !== undefined && item !== '' && rest.length === 0 && isReachKind(kind) && reaches(reach, workspace, kind, item)
  )
}

/** No extra twice. */
const Extras = Schema.Array(Extra).check(Schema.makeFilter((extras) => new Set(extras).size === extras.length))

/** A grant's terms: its name (the key's, or the client's as it registered), level, reach, extras and lifetime. */
export const GrantTerms = Schema.Struct({
  name: NonEmptyString(100),
  level: Level,
  reach: GoblinReach,
  extras: Extras,
  lifetime: Lifetime,
})
export type GrantTerms = typeof GrantTerms.Type

/** One extra as the editor offers it: risky ones are never carried over by the default chain. */
export const ExtraOption = Schema.Struct({
  id: Extra,
  risky: Schema.Boolean,
  /** Only a workspace's owner may grant it. */
  ownerOnly: Schema.optionalKey(Schema.Boolean),
})
export type ExtraOption = typeof ExtraOption.Type

/** goblin's grant vocabulary, as myapps' `AppGrantSpec` describes an app's. */
export interface GrantSpec {
  /** Ordered from least to most access. */
  readonly levels: readonly Level[]
  readonly extras: readonly ExtraOption[]
  /** The terms with no history to go on; the caller supplies the name (`presetFor`). */
  readonly preset: GrantTerms
  readonly defaultLifetime: Lifetime
  /** Whether a reach holds a reach id (`reachId`). */
  readonly allowsReach: (reach: GoblinReach, id: string) => boolean
}

const everything = (workspace: string): WorkspaceReach => ({
  workspace,
  topics: { kind: 'all' },
  personas: { kind: 'all' },
  connections: { kind: 'all' },
})

/**
 * A new credential's terms when nothing came before it: `write`, every Topic, Persona and connection, no extras, until
 * revoked, over `workspaces`: all of the person's for an MCP client, or those listed (a key's one workspace).
 */
export const presetFor = (name: string, workspaces: 'all' | readonly string[]): GrantTerms => ({
  name,
  level: 'write',
  reach:
    workspaces === 'all'
      ? { workspaces: 'all', each: [], origins: [] }
      : { workspaces: 'list', each: workspaces.map(everything), origins: [] },
  extras: [],
  lifetime: 'never',
})

/** The preset of a new MCP client before it is named: over all of its person's workspaces. */
export const PRESET: GrantTerms = presetFor('MCP client', 'all')

/** goblin's spec: the levels in order, the extras and which are risky, the preset and lifetime, and reach membership. */
export const GRANT_SPEC: GrantSpec = {
  levels: Level.literals,
  extras: [
    { id: 'setup', risky: true },
    { id: 'routines', risky: true },
    { id: 'inspect', risky: false },
    { id: 'keys', risky: true, ownerOnly: true },
  ],
  preset: PRESET,
  defaultLifetime: 'never',
  allowsReach,
}

/**
 * The terms a consent or a new key starts from: the same client's last terms, else the latest grant of the person's
 * with its risky extras taken off, else the spec's preset. The caller supplies the name in the preset; history keeps
 * its saved name.
 */
export const defaultTerms = (
  spec: GrantSpec,
  history: { readonly sameClient?: GrantTerms; readonly latest?: GrantTerms },
): GrantTerms => {
  if (history.sameClient !== undefined) return history.sameClient
  if (history.latest === undefined) return spec.preset
  const safe = new Set(spec.extras.filter((extra) => !extra.risky).map((extra) => extra.id))
  return { ...history.latest, extras: history.latest.extras.filter((extra) => safe.has(extra)) }
}

/** Whether `have` is at least `need` in the spec's order. A level outside it fails closed. */
export const levelAtLeast = (spec: { readonly levels: readonly string[] }, have: string, need: string): boolean => {
  const haveIndex = spec.levels.indexOf(have)
  const needIndex = spec.levels.indexOf(need)
  return haveIndex !== -1 && needIndex !== -1 && haveIndex >= needIndex
}

/**
 * What a refusal says is missing: a level, a reach item (`reachId`), an extra, or creating something new (a name, so
 * asking reveals no existing id).
 */
export const Missing = Schema.Struct({
  level: Schema.optionalKey(Level),
  reachId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  extra: Schema.optionalKey(Extra),
  create: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
})
export type Missing = typeof Missing.Type

/** What an owner endpoint needs of a credential (`EndpointAccess`): a level, and an extra when it takes one. */
export interface Need {
  readonly level: Level
  readonly extra?: Extra
}

/**
 * Everything `need` asks for that `terms` lacks, or `null` when nothing is. Terms without their reach (a forwarded
 * credential carries none) lack every reach id.
 */
export const missingFor = (
  spec: GrantSpec,
  terms: Pick<GrantTerms, 'level' | 'extras'> & { readonly reach?: GoblinReach | undefined },
  need: { readonly level?: Level; readonly reachId?: string; readonly extra?: Extra },
): Missing | null => {
  const missing: Missing = {
    ...(need.level !== undefined && !levelAtLeast(spec, terms.level, need.level) ? { level: need.level } : {}),
    ...(need.reachId !== undefined && (terms.reach === undefined || !spec.allowsReach(terms.reach, need.reachId))
      ? { reachId: need.reachId }
      : {}),
    ...(need.extra !== undefined && !terms.extras.includes(need.extra) ? { extra: need.extra } : {}),
  }
  return Object.keys(missing).length === 0 ? null : missing
}

/**
 * The widening page for `grantId` asking for `missing`: `<appUrl>/consent/widen?grant=…&level=&reach=&extra=&create=`.
 * The app URL is trusted configuration; every term is encoded as a query value.
 */
export const widenUrl = (appUrl: string, grantId: string, missing: Missing): string => {
  const url = new URL(`${appUrl.replace(/\/$/u, '')}/consent/widen`)
  url.searchParams.set('grant', grantId)
  if (missing.level !== undefined) url.searchParams.set('level', missing.level)
  if (missing.reachId !== undefined) url.searchParams.set('reach', missing.reachId)
  if (missing.extra !== undefined) url.searchParams.set('extra', missing.extra)
  if (missing.create !== undefined) url.searchParams.set('create', missing.create)
  return url.href
}

/** The power a person's role in a workspace gives them, as a grant's level and extras would. */
export interface Power {
  readonly level: Level
  readonly extras: readonly Extra[]
}

/** Each workspace role's power: an owner everything, an admin all but `keys`, a member `write` and `inspect`. */
export const ROLE_POWER: Readonly<Record<WorkspaceRole, Power>> = {
  owner: { level: 'manage', extras: ['setup', 'routines', 'inspect', 'keys'] },
  admin: { level: 'manage', extras: ['setup', 'routines', 'inspect'] },
  member: { level: 'write', extras: ['inspect'] },
}

/**
 * `GET /api/access` and the consent summary: a grant's terms, which grant and credential they are (a key's or a
 * client's id), when it ends (ISO, or `null` until revoked) and its widening link.
 */
export const AccessSummary = Schema.Struct({
  ...GrantTerms.fields,
  grantId: Schema.String,
  clientId: Schema.optionalKey(Schema.String),
  keyId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  widenUrl: Schema.String,
})
export type AccessSummary = typeof AccessSummary.Type

/**
 * One thing the editor offers to reach. For goblin: one option per workspace (its id), whose children are its Topics,
 * Personas and connections as groups that are not themselves selectable, whose children are reach ids (`reachId`).
 * `usedBy` names the other grants that reach it.
 */
export interface ReachOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** `false` for a group label that cannot itself be granted. */
  readonly selectable?: boolean
  readonly children?: readonly ReachOption[]
  readonly usedBy?: readonly { readonly grantId: string; readonly name: string }[]
}
export const ReachOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  selectable: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<ReachOption> => ReachOption))),
  usedBy: Schema.optionalKey(Schema.Array(Schema.Struct({ grantId: Schema.String, name: Schema.String }))),
})

/**
 * What the consent and widening pages show (`GET /api/clients/:clientId/terms`, `GET /api/grants/:id/terms`): what may
 * be chosen, the default chain's terms, the grant's current terms (`null` before it has any) and, for a live grant,
 * its summary and id.
 */
export const ConsentTerms = Schema.Struct({
  spec: Schema.Struct({
    levels: Schema.Array(Level),
    extras: Schema.Array(ExtraOption),
    reachOptions: Schema.Array(ReachOption),
  }),
  defaults: GrantTerms,
  current: Schema.NullOr(GrantTerms),
  summary: Schema.optionalKey(AccessSummary),
  grantId: Schema.optionalKey(Schema.String),
})
export type ConsentTerms = typeof ConsentTerms.Type

/** `PUT /api/grants/:id`: the terms the owner approves for that grant, widened or narrowed. */
export const WidenRequest = Schema.Struct({ grantId: Schema.String, terms: GrantTerms })
export type WidenRequest = typeof WidenRequest.Type

/** A grant's terms as saved, and when it ends now (ISO, or `null` until revoked). */
export const WidenResult = Schema.Struct({ ...WidenRequest.fields, expiresAt: Schema.NullOr(Schema.String) })
export type WidenResult = typeof WidenResult.Type

/** `PUT /api/clients/:clientId/grant`: the terms the person approves for an MCP client, before or after its consent. */
export const ClientGrantTerms = Schema.Struct({ terms: GrantTerms })
export type ClientGrantTerms = typeof ClientGrantTerms.Type
