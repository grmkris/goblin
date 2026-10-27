import {
  Extra,
  type GoblinReach,
  type GrantTerms,
  GrantOrigin,
  Level,
  Lifetime,
  type ReachKind,
  type WorkspaceReach,
  type WorkspaceRole,
  expiresAt as endOf,
  grantOriginsOf,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../env.ts'
import type { Credential } from '../http/api/principal.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'

/**
 * Every credential's grant (`packages/contracts/src/grants.ts`, myapps ADR 0015) in goblin's own auth D1 tables (0005):
 * an OAuth client has one per person who approved it; an installed app (ADRs 0118, 0125) one per installation, its id
 * the installation's. Its terms are the row (level, extras, lifetime, origins, whether it reaches all of its person's
 * workspaces), one `grantWorkspace` row per workspace it names (each kind `all` or `list`, with the generation an agent
 * compares to know its lists moved) and the listed ids in `grantReach`. Plain async over D1, like `clients.ts`; a
 * change that spans rows is one batch, which D1 runs as a transaction.
 */

type Database = RuntimeEnv['AUTH_DB']

/** Whether a kind of reach is everything of the workspace's, or the listed ids. */
export type Coverage = 'all' | 'list'

/** A grant as the auth store keeps it; times are epoch milliseconds. */
export interface GrantRecord {
  readonly id: string
  readonly kind: 'client' | 'app'
  readonly clientId: string
  readonly userId: string | undefined
  readonly name: string
  readonly level: Level
  readonly extras: readonly Extra[]
  readonly lifetime: Lifetime
  readonly expiresAt: number | null
  readonly workspacesAll: boolean
  readonly origins: readonly GrantOrigin[]
  readonly revokedAt: number | null
}

/** The credential `grant` makes in a workspace whose coverage is `ws`, for the client or app `identity` names. */
export const credentialOf = (
  grant: GrantRecord,
  identity: { readonly id: string; readonly name: string },
  ws: Credential['ws'],
): Credential => ({
  kind: grant.kind,
  id: identity.id,
  name: identity.name.slice(0, 200),
  grantId: grant.id,
  level: grant.level,
  extras: grant.extras,
  expiresAt: grant.expiresAt,
  ws,
  origins: grant.origins,
})

/** What a grant reaches in one workspace without its lists: each kind all or a list, and the lists' generation. */
export interface WorkspaceCoverage {
  readonly workspace: string
  readonly topics: Coverage
  readonly personas: Coverage
  readonly connections: Coverage
  readonly generation: number
}

interface GrantRow {
  readonly id: string
  readonly kind: string
  readonly clientId: string
  readonly userId: string | null
  readonly name: string
  readonly level: string
  readonly extras: string
  readonly lifetime: string
  readonly expiresAt: string | number | null
  readonly workspacesAll: number
  readonly origins: string
  readonly revokedAt: string | number | null
}

interface CoverageRow {
  readonly workspaceId: string
  readonly topics: string
  readonly personas: string
  readonly connections: string
  readonly generation: number
}

interface ReachRow {
  readonly workspaceId: string
  readonly kind: string
  readonly resourceId: string
}

const decodeLevel = Schema.decodeUnknownOption(Level)
const decodeLifetime = Schema.decodeUnknownOption(Lifetime)
const decodeExtras = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Extra)))
const decodeOrigins = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(GrantOrigin)))
const isReachKind = Schema.is(Schema.Literals(['topic', 'persona', 'connection']))

/** A stored time as epoch milliseconds: D1 keeps Better Auth's dates as ISO text, and ours alike. */
const millis = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Date.parse(value)

const iso = (at: number): string => new Date(at).toISOString()

/** A row as its record; anything unreadable reads as the least it could mean (`read`, no extras, no origins). */
const recordOf = (row: GrantRow): GrantRecord => ({
  id: row.id,
  kind: row.kind === 'app' ? 'app' : 'client',
  clientId: row.clientId,
  userId: row.userId ?? undefined,
  name: row.name,
  level: Option.getOrElse(decodeLevel(row.level), () => 'read' as const),
  extras: Option.getOrElse(decodeExtras(row.extras), () => []),
  lifetime: Option.getOrElse(decodeLifetime(row.lifetime), () => 'never' as const),
  expiresAt: millis(row.expiresAt),
  workspacesAll: row.workspacesAll === 1,
  origins: Option.getOrElse(decodeOrigins(row.origins), () => []),
  revokedAt: millis(row.revokedAt),
})

const coverage = (value: string): Coverage => (value === 'all' ? 'all' : 'list')

const coverageOf = (row: CoverageRow): WorkspaceCoverage => ({
  workspace: row.workspaceId,
  topics: coverage(row.topics),
  personas: coverage(row.personas),
  connections: coverage(row.connections),
  generation: row.generation,
})

const COLUMNS = `"id", "kind", "clientId", "userId", "name", "level", "extras", "lifetime", "expiresAt",
  "workspacesAll", "origins", "revokedAt"`

const one = async (db: Database, where: string, ...values: string[]): Promise<GrantRecord | undefined> => {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM "grant" WHERE ${where}`)
    .bind(...values)
    .first<GrantRow>()
  return row === null ? undefined : recordOf(row)
}

/** The grant with id `id`, live or not. */
export const grantById = (db: Database, id: string) => one(db, '"id" = ?', id)

/** The grant `userId` gave MCP client `clientId`, live or not. */
export const grantOfClient = (db: Database, clientId: string, userId: string) =>
  one(db, '"clientId" = ? AND "userId" = ?', clientId, userId)

/** Whether `grant` admits at `now`: never revoked, and not past its end. */
export const isLive = (grant: GrantRecord, now: number): boolean =>
  grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now)

const EVERYTHING = { topics: 'all', personas: 'all', connections: 'all' } as const

/**
 * What `grant` reaches in `workspaceId`: its row there, or, for one that reaches all of its person's workspaces and
 * names none of its own there, everything (generation 0); none when it does not reach the workspace. Membership is the
 * caller's to check.
 */
export const coverageIn = async (
  db: Database,
  grant: GrantRecord,
  workspaceId: string,
): Promise<WorkspaceCoverage | undefined> => {
  const row = await db
    .prepare(
      `SELECT "workspaceId", "topics", "personas", "connections", "generation" FROM "grantWorkspace"
        WHERE "grantId" = ? AND "workspaceId" = ?`,
    )
    .bind(grant.id, workspaceId)
    .first<CoverageRow>()
  if (row !== null) return coverageOf(row)
  return grant.workspacesAll ? { workspace: workspaceId, ...EVERYTHING, generation: 0 } : undefined
}

/** What `grant` reaches in each workspace it names, by workspace (`coverageIn` for one, without the default). */
export const coveragesOf = async (
  db: Database,
  grant: GrantRecord,
): Promise<ReadonlyMap<string, WorkspaceCoverage>> => {
  const { results } = await db
    .prepare(
      `SELECT "workspaceId", "topics", "personas", "connections", "generation" FROM "grantWorkspace" WHERE "grantId" = ?`,
    )
    .bind(grant.id)
    .all<CoverageRow>()
  return new Map(results.map((row) => [row.workspaceId, coverageOf(row)]))
}

/** One listed reach item: what it names and its id (a Topic's or Persona's number in decimal, a connection's id). */
export interface ReachItem {
  readonly kind: ReachKind
  readonly id: string
}

/**
 * What an agent mirrors of `grantId` in `workspaceId` (ADR 0114): its coverage there, when it reaches it, and its
 * listed ids. One D1 round trip.
 */
export const reachRows = async (
  db: Database,
  grantId: string,
  workspaceId: string,
): Promise<{ readonly coverage: WorkspaceCoverage | undefined; readonly items: readonly ReachItem[] }> => {
  const grant = await grantById(db, grantId)
  if (grant === undefined) return { coverage: undefined, items: [] }
  const [covered, rows] = await Promise.all([
    coverageIn(db, grant, workspaceId),
    db
      .prepare('SELECT "workspaceId", "kind", "resourceId" FROM "grantReach" WHERE "grantId" = ? AND "workspaceId" = ?')
      .bind(grantId, workspaceId)
      .all<ReachRow>(),
  ])
  return {
    coverage: covered,
    items: rows.results.flatMap((row) => (isReachKind(row.kind) ? [{ kind: row.kind, id: row.resourceId }] : [])),
  }
}

const FIELD = { topic: 'topics', persona: 'personas', connection: 'connections' } as const satisfies Record<
  ReachKind,
  keyof WorkspaceReach
>
const KINDS = ['topic', 'persona', 'connection'] as const

/** `grant`'s terms: its row, then each workspace it names with its lists. */
export const termsOf = async (db: Database, grant: GrantRecord): Promise<GrantTerms> => {
  const [workspaces, items] = await db.batch<CoverageRow & ReachRow>([
    db
      .prepare(
        `SELECT "workspaceId", "topics", "personas", "connections", "generation" FROM "grantWorkspace"
          WHERE "grantId" = ? ORDER BY "workspaceId"`,
      )
      .bind(grant.id),
    db
      .prepare(
        'SELECT "workspaceId", "kind", "resourceId" FROM "grantReach" WHERE "grantId" = ? ORDER BY "kind", "resourceId"',
      )
      .bind(grant.id),
  ])
  const listed = items?.results ?? []
  const each = (workspaces?.results ?? []).map((row): WorkspaceReach => {
    const list = (kind: ReachKind, covered: string) =>
      covered === 'all'
        ? ({ kind: 'all' } as const)
        : {
            kind: 'list' as const,
            ids: listed
              .filter((item) => item.workspaceId === row.workspaceId && item.kind === kind)
              .map((i) => i.resourceId),
          }
    return {
      workspace: row.workspaceId,
      topics: list('topic', row.topics),
      personas: list('persona', row.personas),
      connections: list('connection', row.connections),
    }
  })
  return {
    name: grant.name,
    level: grant.level,
    reach: { workspaces: grant.workspacesAll ? 'all' : 'list', each, origins: grant.origins },
    extras: grant.extras,
    lifetime: grant.lifetime,
  }
}

/** Origins as a grant stores them (ADR 0091), or the approver's input refused for its first problem. */
const checkedOrigins = (origins: readonly GrantOrigin[]): readonly GrantOrigin[] => {
  const checked = grantOriginsOf(origins)
  if ('problem' in checked) throw new InvalidInput({ reason: checked.problem })
  return checked.origins
}

/** A grant's workspaces as one JSON value: each with its coverage of Topics, Personas and connections. */
const workspacesJson = (terms: GrantTerms): string =>
  JSON.stringify(
    terms.reach.each.map((each) => ({
      workspace: each.workspace,
      topics: each.topics.kind,
      personas: each.personas.kind,
      connections: each.connections.kind,
    })),
  )

/** A grant's listed ids as one JSON value: each with its workspace and kind. */
const listedJson = (terms: GrantTerms): string =>
  JSON.stringify(
    terms.reach.each.flatMap((each) =>
      KINDS.flatMap((kind) => {
        const list = each[FIELD[kind]]
        return list.kind === 'all' ? [] : [...new Set(list.ids)].map((id) => ({ workspace: each.workspace, kind, id }))
      }),
    ),
  )

/**
 * The statements that make `terms` grant `grantId`'s from now on: its row, its workspaces and its lists. A grant's
 * workspaces and ids travel as one JSON value each (`json_each`), so the statements stay five however many it names:
 * D1 binds at most 100 values to a statement, and a list may hold thousands of ids.
 */
const termsStatements = (
  db: Database,
  grantId: string,
  terms: GrantTerms,
  now: number,
): readonly D1PreparedStatement[] => {
  const workspaces = workspacesJson(terms)
  return [
    db
      .prepare(
        `UPDATE "grant" SET "name" = ?, "level" = ?, "extras" = ?, "lifetime" = ?, "expiresAt" = ?, "workspacesAll" = ?,
          "origins" = ?, "revokedAt" = NULL, "updatedAt" = ? WHERE "id" = ?`,
      )
      .bind(
        terms.name,
        terms.level,
        JSON.stringify([...new Set(terms.extras)]),
        terms.lifetime,
        ((end) => (end === null ? null : iso(end)))(endOf(terms.lifetime, now)),
        terms.reach.workspaces === 'all' ? 1 : 0,
        JSON.stringify(checkedOrigins(terms.reach.origins)),
        iso(now),
        grantId,
      ),
    db.prepare('DELETE FROM "grantReach" WHERE "grantId" = ?').bind(grantId),
    db
      .prepare(
        `DELETE FROM "grantWorkspace" WHERE "grantId" = ?
          AND "workspaceId" NOT IN (SELECT json_extract(value, '$.workspace') FROM json_each(?))`,
      )
      .bind(grantId, workspaces),
    // The generation only ever moves on: one past the last, or now, whichever is later, so a workspace named again
    // after it was dropped never repeats a generation an agent mirrored.
    db
      .prepare(
        `INSERT INTO "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
          SELECT ?, json_extract(value, '$.workspace'), json_extract(value, '$.topics'), json_extract(value, '$.personas'),
            json_extract(value, '$.connections'), ? FROM json_each(?) WHERE true
          ON CONFLICT ("grantId", "workspaceId") DO UPDATE SET "topics" = excluded."topics",
            "personas" = excluded."personas", "connections" = excluded."connections",
            "generation" = max("grantWorkspace"."generation" + 1, excluded."generation")`,
      )
      .bind(grantId, now, workspaces),
    db
      .prepare(
        `INSERT INTO "grantReach" ("grantId", "workspaceId", "kind", "resourceId")
          SELECT ?, json_extract(value, '$.workspace'), json_extract(value, '$.kind'), json_extract(value, '$.id')
          FROM json_each(?)`,
      )
      .bind(grantId, listedJson(terms)),
  ]
}

/** `reach` within `workspaces` only: what a grant may name. */
const within = (reach: GoblinReach, workspaces: ReadonlySet<string>): GoblinReach => ({
  ...reach,
  each: reach.each.filter((each) => workspaces.has(each.workspace)),
})

const everything = (workspace: string): WorkspaceReach => ({
  workspace,
  topics: { kind: 'all' },
  personas: { kind: 'all' },
  connections: { kind: 'all' },
})

/**
 * An installation's terms as its grant keeps them: its one workspace, listed, with what the terms say there (everything
 * when they name nothing for it); any other workspace is dropped.
 */
export const workspaceTerms = (terms: GrantTerms, workspaceId: string): GrantTerms => ({
  ...terms,
  reach: {
    workspaces: 'list',
    each: [terms.reach.each.find((each) => each.workspace === workspaceId) ?? everything(workspaceId)],
    origins: terms.reach.origins,
  },
})

/** The workspaces `userId` is a member of, with their role in each. */
const rolesOf = async (db: Database, userId: string): Promise<ReadonlyMap<string, WorkspaceRole>> => {
  const { results } = await db
    .prepare('SELECT "organizationId" AS workspace, "role" FROM "member" WHERE "userId" = ?')
    .bind(userId)
    .all<{ workspace: string; role: string }>()
  return new Map(
    results.map(({ workspace, role }) => [workspace, role === 'owner' || role === 'admin' ? role : 'member']),
  )
}

/** The one workspace an installed app's grant (its installation's, ADR 0118) belongs to. */
const workspaceOfGrant = async (db: Database, grant: GrantRecord): Promise<string | undefined> =>
  (
    await db
      .prepare('SELECT "workspaceId" AS workspace FROM "installation" WHERE "id" = ?')
      .bind(grant.id)
      .first<{ workspace: string }>()
  )?.workspace

/**
 * The terms `approver` (a person's user ID) may give `grant`, as saved: an installed app's need an owner or admin of
 * its workspace and reach only it; a client's need its own person and reach only workspaces they are a member of. A
 * grant they may not approve is `NotFound` (`grant`), so asking reveals none.
 */
export const approvedTerms = async (
  db: Database,
  approver: string,
  grant: GrantRecord,
  terms: GrantTerms,
): Promise<GrantTerms> => {
  const roles = await rolesOf(db, approver)
  if (grant.kind !== 'client') {
    const workspace = await workspaceOfGrant(db, grant)
    const role = workspace === undefined ? undefined : roles.get(workspace)
    if (workspace === undefined || role === undefined || role === 'member') throw new NotFound({ what: 'grant' })
    return workspaceTerms(terms, workspace)
  }
  if (grant.userId !== approver) throw new NotFound({ what: 'grant' })
  return { ...terms, reach: within(terms.reach, new Set(roles.keys())) }
}

/**
 * The terms a new installation of `workspaceId` starts with: its one workspace, origins checked. The caller checks that
 * the person may install apps there at all.
 */
export const newWorkspaceTerms = (workspaceId: string, terms: GrantTerms): GrantTerms => {
  const saved = workspaceTerms(terms, workspaceId)
  return { ...saved, reach: { ...saved.reach, origins: checkedOrigins(saved.reach.origins) } }
}

/**
 * Whether `approver` may see and change `grant`: its installation's workspace's owner or admin, or its client's person.
 */
export const mayApprove = async (db: Database, approver: string, grant: GrantRecord): Promise<boolean> => {
  if (grant.kind === 'client') return grant.userId === approver
  const workspace = await workspaceOfGrant(db, grant)
  const role = workspace === undefined ? undefined : (await rolesOf(db, approver)).get(workspace)
  return role === 'owner' || role === 'admin'
}

/**
 * `terms` as `grant`'s from now on, approved by `approver` at `now` (`approvedTerms`): its end recomputed from its
 * lifetime, every workspace it names a new generation, and a revoked client grant live again. What it saved.
 */
export const setTerms = async (
  db: Database,
  approver: string,
  grant: GrantRecord,
  terms: GrantTerms,
  now: number,
): Promise<GrantTerms> => {
  const approved = await approvedTerms(db, approver, grant, terms)
  await db.batch([...termsStatements(db, grant.id, approved, now)])
  return approved
}

/** The statement that makes a grant row; its terms follow (`termsStatements`). */
const insertGrant = (
  db: Database,
  row: { readonly id: string; readonly kind: GrantRecord['kind']; readonly createdBy: string; readonly name: string },
  owner: { readonly clientId: string; readonly userId?: string },
  now: number,
) =>
  db
    .prepare(
      `INSERT INTO "grant" ("id", "kind", "clientId", "userId", "name", "level", "createdBy", "createdAt", "updatedAt")
        VALUES (?, ?, ?, ?, ?, 'read', ?, ?, ?)`,
    )
    .bind(row.id, row.kind, owner.clientId, owner.userId ?? null, row.name, row.createdBy, iso(now), iso(now))

/**
 * The statements that make grant `row` (as `owner`'s: a client and its person, or an app's client) with `terms` as
 * saved; a caller adds its own to the same batch.
 */
export const newGrantStatements = (
  db: Database,
  row: { readonly id: string; readonly kind: GrantRecord['kind']; readonly createdBy: string; readonly name: string },
  owner: { readonly clientId: string; readonly userId?: string },
  terms: GrantTerms,
  now: number,
): readonly D1PreparedStatement[] => [insertGrant(db, row, owner, now), ...termsStatements(db, row.id, terms, now)]

/**
 * `terms` as the grant `userId` gives MCP client `clientId` (the consent page before its consent, Settings later): a
 * new grant the first time, else theirs again with these terms. A client that is not registered is `NotFound`.
 */
export const setClientTerms = async (
  db: Database,
  userId: string,
  clientId: string,
  terms: GrantTerms,
  now: number,
): Promise<{ readonly grant: GrantRecord; readonly terms: GrantTerms }> => {
  const client = await db.prepare('SELECT "clientId" FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).first()
  if (client === null) throw new NotFound({ what: 'client' })
  const existing = await grantOfClient(db, clientId, userId)
  const id = existing?.id ?? `cg_${crypto.randomUUID().replaceAll('-', '')}`
  const draft: GrantRecord = existing ?? {
    id,
    kind: 'client',
    clientId,
    userId,
    name: terms.name,
    level: 'read',
    extras: [],
    lifetime: 'never',
    expiresAt: null,
    workspacesAll: false,
    origins: [],
    revokedAt: null,
  }
  const approved = await approvedTerms(db, userId, draft, terms)
  await db.batch([
    ...(existing === undefined
      ? [insertGrant(db, { id, kind: 'client', createdBy: userId, name: terms.name }, { clientId, userId }, now)]
      : []),
    ...termsStatements(db, id, approved, now),
  ])
  const saved = await grantById(db, id)
  if (saved === undefined) throw new NotFound({ what: 'grant' })
  return { grant: saved, terms: approved }
}

/**
 * Adds what a credential made to its list (ADR 0114): a Topic or Persona it created is within its reach from then on.
 * Nothing when its reach of that kind in the workspace is all, or the id is listed already; else the id is listed and
 * the workspace's generation moves on. One batch.
 */
export const appendReach = async (
  db: Database,
  grantId: string,
  workspaceId: string,
  item: ReachItem,
  now: number,
): Promise<void> => {
  const row = await db
    .prepare(
      `SELECT w."${FIELD[item.kind]}" AS covered,
          EXISTS (SELECT 1 FROM "grantReach" r WHERE r."grantId" = w."grantId" AND r."workspaceId" = w."workspaceId"
            AND r."kind" = ? AND r."resourceId" = ?) AS listed
        FROM "grantWorkspace" w WHERE w."grantId" = ? AND w."workspaceId" = ?`,
    )
    .bind(item.kind, item.id, grantId, workspaceId)
    .first<{ covered: string; listed: number }>()
  if (row === null || row.covered === 'all' || row.listed === 1) return
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO "grantReach" ("grantId", "workspaceId", "kind", "resourceId") VALUES (?, ?, ?, ?)',
      )
      .bind(grantId, workspaceId, item.kind, item.id),
    db
      .prepare(
        `UPDATE "grantWorkspace" SET "generation" = max("generation" + 1, ?) WHERE "grantId" = ? AND "workspaceId" = ?`,
      )
      .bind(now, grantId, workspaceId),
  ])
}

/**
 * The terms a person's newest client grant held, for the default chain (`defaultTerms`): of client `clientId` when it
 * is named, else of any of theirs. Revoked ones count: the chain remembers what they chose.
 */
export const historyOf = async (db: Database, userId: string, clientId?: string): Promise<GrantTerms | undefined> => {
  const latest = await one(
    db,
    clientId === undefined
      ? `"kind" = 'client' AND "userId" = ? ORDER BY "updatedAt" DESC LIMIT 1`
      : `"kind" = 'client' AND "userId" = ? AND "clientId" = ?`,
    ...(clientId === undefined ? [userId] : [userId, clientId]),
  )
  return latest === undefined ? undefined : termsOf(db, latest)
}

/**
 * Ends `userId`'s grant to MCP client `clientId` now: it is marked revoked (its terms stay, for the default chain), their
 * consent goes and their refresh tokens are revoked, so the client's next sign-in asks again. One batch.
 */
export const revokeClientGrant = (db: Database, userId: string, clientId: string, now: number) =>
  db.batch([
    db
      .prepare('UPDATE "grant" SET "revokedAt" = ?, "updatedAt" = ? WHERE "clientId" = ? AND "userId" = ?')
      .bind(iso(now), iso(now), clientId, userId),
    db.prepare('DELETE FROM "oauthConsent" WHERE "clientId" = ? AND "userId" = ?').bind(clientId, userId),
    db
      .prepare(
        'UPDATE "oauthRefreshToken" SET "revoked" = ? WHERE "clientId" = ? AND "userId" = ? AND "revoked" IS NULL',
      )
      .bind(iso(now), clientId, userId),
  ])
