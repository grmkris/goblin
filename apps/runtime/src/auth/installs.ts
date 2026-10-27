import { APIError } from 'better-auth/api'
import {
  type DeveloperApp,
  GrantTerms,
  type InstallAnswer,
  type InstallApproval,
  type InstallDecline,
  type InstallDeclined,
  type InstallInfo,
  type InstallationView,
  type RegisterApp,
  type RegisteredApp,
  type RotatedAppSecret,
  type WorkspaceReach,
  type WorkspaceView,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../env.ts'
import { Forbidden, Internal, InvalidInput, NotFound } from '../http/errors.ts'
import { clientSecretHash, newClientSecret } from './client-secret.ts'
import { consentSpec } from './consent-terms.ts'
import {
  type GrantRecord,
  type WorkspaceCoverage,
  coverageIn,
  grantById,
  isLive,
  newGrantStatements,
  newWorkspaceTerms,
  setTerms,
  termsOf,
  workspaceTerms,
} from './grants.ts'
import { createAuth } from './options.ts'
import { type Person, type ReachedWorkspace, workspacesOf } from './workspaces.ts'

/**
 * Apps and their installations (ADR 0118), in goblin's own auth D1 tables (0006) beside Better Auth's. An app is a
 * confidential OAuth client goblin registers server-side with the client_credentials grant; it belongs to the workspace
 * that registered it (`app`), never to a person (its `oauthClient` row names none). An installation is the app in a
 * workspace, with its grant (kind `app`, its id the installation's). Plain async over D1, like `clients.ts`; a change
 * that spans rows is one batch.
 */

type Database = RuntimeEnv['AUTH_DB']

const iso = (at: number): string => new Date(at).toISOString()

const decodeTerms = Schema.decodeUnknownOption(Schema.fromJsonString(GrantTerms))
const decodeUrls = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

/** A stored time as ISO text: D1 keeps Better Auth's dates as text, and ours alike. */
const isoOf = (value: string | number | null): string =>
  value === null ? '' : typeof value === 'number' ? iso(value) : value

/** A reach kind as an install starts it: all stays all, a list starts empty (another workspace's ids name nothing). */
const kind = (list: WorkspaceReach['topics'] | undefined) =>
  list?.kind === 'list' ? ({ kind: 'list', ids: [] } as const) : ({ kind: 'all' } as const)

/** What an install starts from: `terms` aimed at `workspaceId`, each kind as `kind` starts it. */
const aimedAt = (terms: GrantTerms, workspaceId: string): GrantTerms => {
  const [first] = terms.reach.each
  return {
    ...terms,
    reach: {
      workspaces: 'list',
      each: [
        {
          workspace: workspaceId,
          topics: kind(first?.topics),
          personas: kind(first?.personas),
          connections: kind(first?.connections),
        },
      ],
      origins: terms.reach.origins,
    },
  }
}

/** The least terms an unreadable stored request reads as: read, nothing listed, until revoked. */
const leastTerms = (name: string, workspaceId: string): GrantTerms => ({
  name,
  level: 'read',
  extras: [],
  lifetime: 'never',
  reach: {
    workspaces: 'list',
    each: [
      { workspace: workspaceId, topics: { kind: 'all' }, personas: { kind: 'all' }, connections: { kind: 'all' } },
    ],
    origins: [],
  },
})

interface AppRow {
  readonly clientId: string
  readonly workspaceId: string
  readonly name: string | null
  readonly uri: string | null
  readonly redirectUris: string | null
  readonly terms: string
  readonly script: number
  readonly createdAt: string | number
  readonly fromName: string
  readonly installs: number
}

const APP_SELECT = `SELECT a."clientId", a."workspaceId", c."name", c."uri", c."redirectUris", a."terms", a."script",
    a."createdAt", o."name" AS fromName,
    (SELECT count(*) FROM "installation" i WHERE i."clientId" = a."clientId") AS installs
  FROM "app" a JOIN "oauthClient" c ON c."clientId" = a."clientId" JOIN "organization" o ON o."id" = a."workspaceId"`

const developerAppOf = (row: AppRow): DeveloperApp => {
  const name = row.name ?? 'an app'
  return {
    clientId: row.clientId,
    name,
    ...(row.uri === null ? {} : { homepage: row.uri }),
    returnUrls: row.redirectUris === null ? [] : Option.getOrElse(decodeUrls(row.redirectUris), () => []),
    terms: Option.getOrElse(decodeTerms(row.terms), () => leastTerms(name, row.workspaceId)),
    script: row.script === 1,
    createdAt: isoOf(row.createdAt),
    installations: row.installs,
  }
}

const appRow = async (db: Database, clientId: string): Promise<AppRow | undefined> =>
  (await db.prepare(`${APP_SELECT} WHERE a."clientId" = ?`).bind(clientId).first<AppRow>()) ?? undefined

/** App `clientId` when workspace `workspaceId` registered it; `NotFound` (`app`) otherwise, so asking reveals none. */
const ownedApp = async (db: Database, workspaceId: string, clientId: string): Promise<AppRow> => {
  const row = await appRow(db, clientId)
  if (row?.workspaceId !== workspaceId) throw new NotFound({ what: 'app' })
  return row
}

interface InstallationRow {
  readonly id: string
  readonly clientId: string
  readonly workspaceId: string
  readonly approvedBy: string | null
  readonly approverName: string | null
  readonly createdAt: string | number
  readonly name: string | null
  readonly uri: string | null
  readonly fromName: string
}

const INSTALLATION_SELECT = `SELECT i."id", i."clientId", i."workspaceId", i."approvedBy", u."name" AS approverName,
    i."createdAt", c."name", c."uri", o."name" AS fromName
  FROM "installation" i JOIN "oauthClient" c ON c."clientId" = i."clientId" JOIN "app" a ON a."clientId" = i."clientId"
    JOIN "organization" o ON o."id" = a."workspaceId" LEFT JOIN "user" u ON u."id" = i."approvedBy"`

const installationViewOf = async (db: Database, row: InstallationRow): Promise<InstallationView> => {
  const grant = await grantById(db, row.id)
  const name = row.name ?? 'an app'
  const terms = grant === undefined ? leastTerms(name, row.workspaceId) : await termsOf(db, grant)
  return {
    id: row.id,
    clientId: row.clientId,
    name,
    ...(row.uri === null ? {} : { homepage: row.uri }),
    from: row.fromName,
    ...(row.approverName === null || row.approverName === '' ? {} : { approvedBy: row.approverName }),
    createdAt: isoOf(row.createdAt),
    ...(grant?.expiresAt === null || grant?.expiresAt === undefined ? {} : { expiresAt: iso(grant.expiresAt) }),
    grantId: row.id,
    terms,
  }
}

/** Installation `id` when it is in `workspaceId`; `NotFound` (`installation`) otherwise. */
const installationIn = async (db: Database, workspaceId: string, id: string): Promise<InstallationRow> => {
  const row = await db
    .prepare(`${INSTALLATION_SELECT} WHERE i."id" = ? AND i."workspaceId" = ?`)
    .bind(id, workspaceId)
    .first<InstallationRow>()
  if (row === null) throw new NotFound({ what: 'installation' })
  return row
}

const newInstallationId = (): string => `in_${crypto.randomUUID().replaceAll('-', '')}`

/**
 * The statements that make installation `installation.id` of app client `clientId` in `workspaceId`, approved by
 * `userId` with `terms` (from `newWorkspaceTerms`): its grant, kind `app` with the installation's id, then its row.
 */
const installationStatements = (
  db: Database,
  installation: {
    readonly id: string
    readonly clientId: string
    readonly workspaceId: string
    readonly userId: string
  },
  terms: GrantTerms,
  now: number,
): readonly D1PreparedStatement[] => [
  ...newGrantStatements(
    db,
    { id: installation.id, kind: 'app', createdBy: installation.userId, name: terms.name },
    { clientId: installation.clientId },
    workspaceTerms(terms, installation.workspaceId),
    now,
  ),
  db
    .prepare(
      'INSERT INTO "installation" ("id", "clientId", "workspaceId", "approvedBy", "createdAt") VALUES (?, ?, ?, ?, ?)',
    )
    .bind(installation.id, installation.clientId, installation.workspaceId, installation.userId, iso(now)),
]

/** Better Auth's server-only admin registration: `options.ts` casts its plugin to `BetterAuthPlugin`, which types it away. */
type AdminCreate = (input: {
  readonly headers: Headers
  readonly body: Readonly<Record<string, unknown>>
}) => Promise<unknown>

/** The admin registration endpoint of `api`, checked to be one. */
const adminCreateOf = (api: object): AdminCreate => {
  if (!('adminCreateOAuthClient' in api)) throw new Internal({ reason: 'app_registration' })
  const endpoint = api.adminCreateOAuthClient
  if (typeof endpoint !== 'function') throw new Internal({ reason: 'app_registration' })
  // SAFETY: the pinned oauth-provider's `adminCreateOAuthClient`, checked to be a function; its answer is decoded
  // (`Created`) before anything reads it.
  return endpoint as AdminCreate
}

/** The client Better Auth registered for an app, as its answer names it. */
const Created = Schema.Struct({ client_id: Schema.String, client_secret: Schema.String })
const decodeCreated = Schema.decodeUnknownOption(Created)

/**
 * App `input`, registered by `userId` for `workspace` (whose owner or admin they are: the account API checks): a
 * confidential client with the client_credentials grant and goblin's one scope, made through Better Auth's server-only
 * admin endpoint with the person's own request headers, then given to the workspace. The terms it asks for are aimed at
 * this workspace (an install aims them at its own). A script app is installed here in the same step. The client secret
 * is answered this once. If goblin's rows cannot be written, the client is removed again.
 */
export const registerApp = async (
  env: RuntimeEnv,
  headers: Headers,
  workspace: WorkspaceView,
  userId: string,
  input: RegisterApp,
): Promise<RegisteredApp> => {
  const db = env.AUTH_DB
  const script = input.script === true
  if (script !== (input.returnUrls.length === 0)) throw new InvalidInput({ reason: 'return_url' })
  const terms = newWorkspaceTerms(workspace.id, aimedAt({ ...input.terms, name: input.name }, workspace.id))
  const answer = await adminCreateOf(createAuth(env, db).api)({
    headers,
    body: {
      client_name: input.name,
      ...(input.homepage === undefined ? {} : { client_uri: input.homepage }),
      ...(input.returnUrls.length === 0 ? {} : { redirect_uris: [...input.returnUrls] }),
      grant_types: ['client_credentials'],
      response_types: [],
      token_endpoint_auth_method: 'client_secret_basic',
      client_credentials_scopes: ['goblin'],
      scope: 'goblin',
    },
  }).catch((cause: unknown) => {
    // The provider refusing the registration (an address it will not take) is the input's fault, not ours.
    if (cause instanceof APIError && cause.statusCode < 500) throw new InvalidInput({ reason: 'return_url' })
    throw cause
  })
  const created = Option.getOrUndefined(decodeCreated(answer))
  if (created === undefined) throw new Internal({ reason: 'app_registration' })
  const now = Date.now()
  const installationId = script ? newInstallationId() : undefined
  try {
    await db.batch([
      // The client is the workspace's, not the person's who registered it: it outlives them (its row would cascade with
      // a person it named).
      db
        .prepare('UPDATE "oauthClient" SET "userId" = NULL, "referenceId" = ? WHERE "clientId" = ?')
        .bind(`workspace:${workspace.id}`, created.client_id),
      db
        .prepare(
          'INSERT INTO "app" ("clientId", "workspaceId", "terms", "script", "createdBy", "createdAt") VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(created.client_id, workspace.id, JSON.stringify(terms), script ? 1 : 0, userId, iso(now)),
      ...(installationId === undefined
        ? []
        : installationStatements(
            db,
            { id: installationId, clientId: created.client_id, workspaceId: workspace.id, userId },
            terms,
            now,
          )),
    ])
  } catch (cause) {
    await db.prepare('DELETE FROM "oauthClient" WHERE "clientId" = ?').bind(created.client_id).run()
    throw cause
  }
  const row = await appRow(db, created.client_id)
  if (row === undefined) throw new NotFound({ what: 'app' })
  return {
    app: developerAppOf(row),
    clientSecret: created.client_secret,
    ...(installationId === undefined
      ? {}
      : { installation: await installationViewOf(db, await installationIn(db, workspace.id, installationId)) }),
  }
}

/** The apps workspace `workspaceId` registered, newest first. */
export const listApps = async (env: RuntimeEnv, workspaceId: string): Promise<readonly DeveloperApp[]> => {
  const { results } = await env.AUTH_DB.prepare(`${APP_SELECT} WHERE a."workspaceId" = ? ORDER BY a."createdAt" DESC`)
    .bind(workspaceId)
    .all<AppRow>()
  return results.map(developerAppOf)
}

/**
 * A new client secret for app `clientId` of `workspaceId`, written as the token endpoint checks it (`client-secret.ts`)
 * and answered this once; the old one admits nothing from then on.
 */
export const rotateAppSecret = async (
  env: RuntimeEnv,
  workspaceId: string,
  clientId: string,
): Promise<RotatedAppSecret> => {
  await ownedApp(env.AUTH_DB, workspaceId, clientId)
  const clientSecret = newClientSecret()
  await env.AUTH_DB.prepare('UPDATE "oauthClient" SET "clientSecret" = ?, "updatedAt" = ? WHERE "clientId" = ?')
    .bind(await clientSecretHash(clientSecret), iso(Date.now()), clientId)
    .run()
  return { clientId, clientSecret }
}

/** Every installation of app `clientId` of `workspaceId`, by id and workspace: whose Events leases end first. */
export const installationsOfApp = async (
  env: RuntimeEnv,
  workspaceId: string,
  clientId: string,
): Promise<readonly { readonly id: string; readonly workspaceId: string }[]> => {
  await ownedApp(env.AUTH_DB, workspaceId, clientId)
  const { results } = await env.AUTH_DB.prepare('SELECT "id", "workspaceId" FROM "installation" WHERE "clientId" = ?')
    .bind(clientId)
    .all<{ id: string; workspaceId: string }>()
  return results
}

/** Ends app `clientId` of `workspaceId`: its client goes, and with it every installation, grant and token. */
export const deleteApp = async (env: RuntimeEnv, workspaceId: string, clientId: string): Promise<void> => {
  await ownedApp(env.AUTH_DB, workspaceId, clientId)
  await env.AUTH_DB.prepare('DELETE FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).run()
}

/** The apps installed in `workspaceId`, newest first, each with its grant. */
export const listInstallations = async (env: RuntimeEnv, workspaceId: string): Promise<readonly InstallationView[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `${INSTALLATION_SELECT} WHERE i."workspaceId" = ? ORDER BY i."createdAt" DESC`,
  )
    .bind(workspaceId)
    .all<InstallationRow>()
  return Promise.all(results.map((row) => installationViewOf(env.AUTH_DB, row)))
}

/** An installation's change: its terms before and after, for leases and the audit line. */
export interface InstallationChange {
  readonly before: GrantTerms
  readonly after: InstallationView
}

/**
 * `terms` as installation `id`'s grant's from now on, approved by `userId` (an owner or admin of `workspaceId`;
 * `setTerms` checks again): its one workspace, `keys` only from an owner. Its name stays the app's.
 */
export const updateInstallation = async (
  env: RuntimeEnv,
  workspaceId: string,
  userId: string,
  id: string,
  terms: GrantTerms,
): Promise<InstallationChange> => {
  const db = env.AUTH_DB
  const row = await installationIn(db, workspaceId, id)
  const grant = await grantById(db, id)
  if (grant === undefined) throw new NotFound({ what: 'installation' })
  const before = await termsOf(db, grant)
  await setTerms(db, userId, grant, { ...terms, name: before.name }, Date.now())
  return { before, after: await installationViewOf(db, row) }
}

/** Ends installation `id` of `workspaceId` now: its grant goes, and the installation with it. */
export const uninstall = async (env: RuntimeEnv, workspaceId: string, id: string): Promise<void> => {
  await installationIn(env.AUTH_DB, workspaceId, id)
  await env.AUTH_DB.prepare('DELETE FROM "grant" WHERE "id" = ? AND "kind" = \'app\'').bind(id).run()
}

/** The workspaces `person` may install `app` in: those they own or administer, a script app's own only. */
const targetsOf = async (db: Database, person: Person, app: AppRow) =>
  (await workspacesOf(db, person, new Date())).filter(
    (workspace) => workspace.role !== 'member' && (app.script !== 1 || workspace.id === app.workspaceId),
  )

/**
 * What the install page shows `person` for app `clientId`: the app, the workspaces they may install it in (and where it
 * is already), and the grant editor over those workspaces, its defaults what the app asks for aimed at the first.
 */
export const installInfo = async (env: RuntimeEnv, person: Person, clientId: string): Promise<InstallInfo> => {
  const db = env.AUTH_DB
  const row = await appRow(db, clientId)
  if (row === undefined) throw new NotFound({ what: 'app' })
  const app = developerAppOf(row)
  const [targets, installed] = await Promise.all([
    targetsOf(db, person, row),
    db
      .prepare('SELECT "workspaceId" FROM "installation" WHERE "clientId" = ?')
      .bind(clientId)
      .all<{ workspaceId: string }>(),
  ])
  const there = new Set(installed.results.map((each) => each.workspaceId))
  const defaults = aimedAt(app.terms, targets[0]?.id ?? row.workspaceId)
  return {
    clientId,
    name: app.name,
    ...(app.homepage === undefined ? {} : { homepage: app.homepage }),
    from: row.fromName,
    script: app.script,
    workspaces: targets.map(({ id, slug, name, role }) => ({ id, slug, name, role, installed: there.has(id) })),
    consent: { spec: consentSpec(targets, defaults.reach), defaults, current: null },
  }
}

/** The address an install sends the person back to: one `app` registered, its first when none is named. */
const returnUrlOf = (app: DeveloperApp, chosen: string | undefined): string => {
  const url = chosen ?? app.returnUrls[0]
  if (url === undefined || !app.returnUrls.includes(url)) throw new InvalidInput({ reason: 'return_url' })
  return url
}

/** `url` with `query` set in its query string. */
const withQuery = (url: string, query: Record<string, string>): string => {
  const target = new URL(url)
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value)
  return target.toString()
}

/**
 * Installs app `clientId` in the workspace `approval` names, for `person` (its owner or admin, else `Forbidden`
 * `role`; a workspace they are not in is `NotFound`), with `approval.terms` as its grant: made, or an installation
 * there given those terms. A script app installs only in its own workspace. Answers the installation and, for an app
 * with return addresses, where to send the person (with `installation`, `workspace`, the slug, and `state`), and the
 * terms an installation already there had, whose narrowing ends its Events leases.
 */
export const approveInstall = async (
  env: RuntimeEnv,
  person: Person,
  clientId: string,
  approval: InstallApproval,
): Promise<{ readonly answer: InstallAnswer; readonly before: GrantTerms | undefined }> => {
  const db = env.AUTH_DB
  const row = await appRow(db, clientId)
  if (row === undefined) throw new NotFound({ what: 'app' })
  const app = developerAppOf(row)
  const workspace = (await workspacesOf(db, person, new Date())).find((each) => each.id === approval.workspace)
  if (workspace === undefined) throw new NotFound({ what: 'workspace' })
  if (workspace.role === 'member') throw new Forbidden({ reason: 'role' })
  if (app.script && workspace.id !== row.workspaceId) throw new InvalidInput({ reason: 'workspace' })
  // The return address is checked before anything is written.
  const returnUrl = app.script ? undefined : returnUrlOf(app, approval.returnUrl)
  const terms = newWorkspaceTerms(workspace.id, aimedAt({ ...approval.terms, name: app.name }, workspace.id))
  const now = Date.now()
  const existing = await db
    .prepare('SELECT "id" FROM "installation" WHERE "clientId" = ? AND "workspaceId" = ?')
    .bind(clientId, workspace.id)
    .first<{ id: string }>()
  const id = existing?.id ?? newInstallationId()
  let before: GrantTerms | undefined
  if (existing === null) {
    await db.batch([
      ...installationStatements(db, { id, clientId, workspaceId: workspace.id, userId: person.id }, terms, now),
    ])
  } else {
    const grant = await grantById(db, id)
    if (grant === undefined) throw new NotFound({ what: 'installation' })
    before = await termsOf(db, grant)
    await setTerms(db, person.id, grant, terms, now)
  }
  const installation = await installationViewOf(db, await installationIn(db, workspace.id, id))
  if (returnUrl === undefined) return { answer: { installation }, before }
  const state = approval.state === undefined ? {} : { state: approval.state }
  const redirect = withQuery(returnUrl, { installation: id, workspace: workspace.slug, ...state })
  return { answer: { installation, redirect }, before }
}

/**
 * The person cancels installing app `clientId`: nothing is written, and an app with return addresses gets the person
 * back at the one `decline` names (its first when none is) with `error=access_denied` and `state`, as an OAuth
 * refusal. A script app has no return address: its answer names none.
 */
export const declineInstall = async (
  env: RuntimeEnv,
  clientId: string,
  decline: InstallDecline,
): Promise<InstallDeclined> => {
  const row = await appRow(env.AUTH_DB, clientId)
  if (row === undefined) throw new NotFound({ what: 'app' })
  const app = developerAppOf(row)
  if (app.script) return {}
  const returnUrl = returnUrlOf(app, decline.returnUrl)
  const state = decline.state === undefined ? {} : { state: decline.state }
  return { redirect: withQuery(returnUrl, { error: 'access_denied', ...state }) }
}

/** One installation an app's token reaches: its workspace, and its grant and coverage there. */
export interface AppInstallation {
  readonly workspace: ReachedWorkspace
  readonly grant: GrantRecord
  readonly coverage: WorkspaceCoverage
}

interface ReachRow {
  readonly id: string
  readonly workspaceId: string
  readonly slug: string
  readonly name: string
  readonly members: number
}

/**
 * The live installations of app `clientId` (ADR 0118): what its token reaches, each workspace with its grant. An app is
 * no member, so its workspaces carry no role; its grant alone decides.
 */
export const appInstallations = async (env: RuntimeEnv, clientId: string): Promise<readonly AppInstallation[]> => {
  const db = env.AUTH_DB
  const { results } = await db
    .prepare(
      `SELECT i."id", o."id" AS workspaceId, o."slug", o."name",
          (SELECT count(*) FROM "member" m WHERE m."organizationId" = o."id") AS members
        FROM "installation" i JOIN "organization" o ON o."id" = i."workspaceId" WHERE i."clientId" = ?
        ORDER BY i."createdAt", i."id"`,
    )
    .bind(clientId)
    .all<ReachRow>()
  const now = Date.now()
  const reached = await Promise.all(
    results.map(async (row): Promise<AppInstallation | undefined> => {
      const grant = await grantById(db, row.id)
      if (grant === undefined || !isLive(grant, now)) return undefined
      const coverage = await coverageIn(db, grant, row.workspaceId)
      if (coverage === undefined) return undefined
      const workspace = { id: row.workspaceId, slug: row.slug, name: row.name, members: row.members }
      return { workspace, grant, coverage }
    }),
  )
  return reached.filter((each) => each !== undefined)
}
