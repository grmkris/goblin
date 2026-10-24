import type { CreateWorkspace, UpdateWorkspace, WorkspaceRole, WorkspaceView } from '@goblin/contracts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'

/**
 * Workspaces (ADR 0089) in the auth D1, in the organization() plugin's own tables: a workspace (`organization`) owns
 * the agent named by its ID, and a person belongs to it through a `member` row with a role. Reads are one query each;
 * a change that spans rows is one D1 batch, which D1 runs as a transaction, so a workspace never exists without its
 * owner. The unique index on a membership's workspace and person keeps out a second one.
 */

type Database = RuntimeEnv['AUTH_DB']

/** The signed-in person, as their session names them. */
export interface Person {
  readonly id: string
  readonly name: string
  readonly email: string
}

interface Row {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly role: string
  readonly members: number
}

const ROLES: readonly string[] = ['owner', 'admin', 'member'] satisfies readonly WorkspaceRole[]
const roleOf = (role: string): WorkspaceRole =>
  // SAFETY: checked against the roles just above; the plugin writes no other.
  (ROLES.includes(role) ? role : 'member') as WorkspaceRole

const viewOf = (row: Row): WorkspaceView => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  role: roleOf(row.role),
  members: row.members,
})

const SELECT = `SELECT o.id AS id, o.name AS name, o.slug AS slug, m.role AS role,
    (SELECT COUNT(*) FROM member c WHERE c.organizationId = o.id) AS members
  FROM member m JOIN organization o ON o.id = m.organizationId`

/**
 * `userId`'s membership of the workspace at `slug` (its address in the app's paths): the workspace and their role, or
 * none when they are not a member.
 */
export const membershipAt = async (db: Database, userId: string, slug: string): Promise<WorkspaceView | undefined> => {
  const row = await db.prepare(`${SELECT} WHERE m.userId = ? AND o.slug = ?`).bind(userId, slug).first<Row>()
  return row === null ? undefined : viewOf(row)
}

/** `userId`'s membership of `workspaceId`: the workspace and their role, or none when they are not a member. */
export const membershipOf = async (
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceView | undefined> => {
  const row = await db
    .prepare(`${SELECT} WHERE m.userId = ? AND m.organizationId = ?`)
    .bind(userId, workspaceId)
    .first<Row>()
  return row === null ? undefined : viewOf(row)
}

/** The workspaces an MCP client reaches for its person now (ADRs 0097, 0114), and whether its grant reaches all. */
export interface Reached {
  readonly all: boolean
  readonly workspaces: readonly WorkspaceView[]
}

/**
 * What `userId`'s grant to MCP client `clientId` reaches now (ADRs 0097, 0114): every workspace they are a member of
 * when it reaches all of theirs (ones joined since included), else those it names that they still are; none without a
 * grant, or with a revoked one. Its end is the token's check (`verifyAccessToken`). One D1 round trip, read on every
 * call.
 */
export const reachedBy = async (db: Database, userId: string, clientId: string): Promise<Reached | undefined> => {
  const [grant, listed] = await db.batch<Row & { readonly everything?: number }>([
    db
      .prepare(
        'SELECT "workspacesAll" AS everything FROM "grant" WHERE "clientId" = ? AND "userId" = ? AND "revokedAt" IS NULL',
      )
      .bind(clientId, userId),
    db
      .prepare(
        `${SELECT} WHERE m.userId = ? AND EXISTS (SELECT 1 FROM "grant" g
          WHERE g."clientId" = ? AND g."userId" = m.userId AND g."revokedAt" IS NULL AND (g."workspacesAll" = 1
            OR EXISTS (SELECT 1 FROM "grantWorkspace" w WHERE w."grantId" = g."id" AND w."workspaceId" = o.id)))
        ORDER BY m.createdAt, o.id`,
      )
      .bind(userId, clientId),
  ])
  const [row] = grant?.results ?? []
  if (row === undefined) return undefined
  return { all: row.everything === 1, workspaces: (listed?.results ?? []).map(viewOf) }
}

const listOf = async (db: Database, userId: string): Promise<readonly WorkspaceView[]> =>
  (await db.prepare(`${SELECT} WHERE m.userId = ? ORDER BY m.createdAt, o.id`).bind(userId).all<Row>()).results.map(
    viewOf,
  )

const newId = (): string => crypto.randomUUID().replaceAll('-', '')
const suffix = (): string => newId().slice(0, 4)

/** A slug from `text`: lowercase letters and digits, runs of anything else one hyphen, 3 to 30 characters. */
export const slugFrom = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 30)
    .replaceAll(/-+$/gu, '')
  return slug.length >= 3 ? slug : `${slug === '' ? 'my' : slug}-ws`
}

const isSlugTaken = (cause: unknown): boolean =>
  cause instanceof Error && /UNIQUE constraint failed: organization\.slug/u.test(cause.message)

/**
 * The statements that make a workspace with `userId` as its owner, guarded by `guard` (a condition both must still
 * meet when the batch runs) when given.
 */
const creation = (db: Database, userId: string, input: CreateWorkspace, now: string, guard?: string) => {
  const id = newId()
  const where = guard === undefined ? '' : ` WHERE ${guard}`
  const bind = guard === undefined ? [] : [userId]
  return {
    id,
    statements: [
      db
        .prepare(`INSERT INTO organization (id, name, slug, createdAt) SELECT ?, ?, ?, ?${where}`)
        .bind(id, input.name, input.slug, now, ...bind),
      db
        .prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) SELECT ?, ?, ?, 'owner', ?${where}`)
        .bind(newId(), id, userId, now, ...bind),
    ],
  }
}

/** A new workspace with `userId` as its owner. A slug another workspace has is a `Conflict` (`slug`). */
export const createWorkspace = async (
  db: Database,
  userId: string,
  input: CreateWorkspace,
  now: Date,
): Promise<WorkspaceView> => {
  const { id, statements } = creation(db, userId, input, now.toISOString())
  try {
    await db.batch(statements)
  } catch (cause) {
    if (isSlugTaken(cause)) throw new Conflict({ reason: 'slug' })
    throw cause
  }
  return { id, name: input.name, slug: input.slug, role: 'owner', members: 1 }
}

/** A name for a person's first workspace: theirs, or their address's local part. */
const firstName = (person: Person): string => {
  const name = person.name.trim() === '' ? (person.email.split('@')[0] ?? '') : person.name.trim()
  return `${name.slice(0, 50)}'s workspace`
}

/**
 * Every workspace `person` belongs to, oldest membership first. A person with none, and no invitation waiting for
 * their address (ADR 0093: they choose to join or to start their own), is given one first: in one batch that runs only
 * while they still have none, so two requests at once make one. Its slug is from their address, with a random ending
 * when that one is taken.
 */
export const workspacesOf = async (db: Database, person: Person, now: Date): Promise<readonly WorkspaceView[]> => {
  const listed = await listOf(db, person.id)
  if (listed.length > 0) return listed
  const invited = await db
    .prepare("SELECT 1 AS found FROM invitation WHERE email = ? AND status = 'pending' AND expiresAt > ? LIMIT 1")
    .bind(person.email.trim().toLowerCase(), now.toISOString())
    .first<{ found: number }>()
  if (invited !== null) return []
  const base = slugFrom(person.email.split('@')[0] ?? '')
  const guard = 'NOT EXISTS (SELECT 1 FROM member WHERE userId = ?)'
  for (const slug of [base, `${base}-${suffix()}`, `${base}-${suffix()}`]) {
    const input = { name: firstName(person), slug }
    try {
      await db.batch(creation(db, person.id, input, now.toISOString(), guard).statements)
      return await listOf(db, person.id)
    } catch (cause) {
      if (!isSlugTaken(cause)) throw cause
    }
  }
  throw new Conflict({ reason: 'slug' })
}

/** `userId`'s membership of `workspaceId` when their role is one of `roles`; `NotFound` or `Forbidden` otherwise. */
const requireRole = async (db: Database, userId: string, workspaceId: string, roles: readonly WorkspaceRole[]) => {
  const membership = await membershipOf(db, userId, workspaceId)
  if (membership === undefined) throw new NotFound({ what: 'workspace' })
  if (!roles.includes(membership.role)) throw new Forbidden({ reason: 'role' })
  return membership
}

/** A new name or slug for a workspace, by its owner or an admin. A slug another workspace has is a `Conflict`. */
export const updateWorkspace = async (
  db: Database,
  userId: string,
  workspaceId: string,
  change: UpdateWorkspace,
): Promise<WorkspaceView> => {
  const membership = await requireRole(db, userId, workspaceId, ['owner', 'admin'])
  const name = change.name ?? membership.name
  const slug = change.slug ?? membership.slug
  try {
    await db.prepare('UPDATE organization SET name = ?, slug = ? WHERE id = ?').bind(name, slug, workspaceId).run()
  } catch (cause) {
    if (isSlugTaken(cause)) throw new Conflict({ reason: 'slug' })
    throw cause
  }
  return { ...membership, name, slug }
}

/**
 * Removes a workspace's records once its agent is gone: its keys with their grants, the apps installed in it with their
 * grants and the apps it registered with every installation of them (ADR 0118), its place in MCP clients' grants (ADRs
 * 0097, 0114), and the workspace, whose memberships and invitations go with it.
 */
const removeRecords = (db: Database, workspaceId: string) =>
  db.batch([
    db.prepare('DELETE FROM "grant" WHERE "keyId" IN (SELECT id FROM apikey WHERE referenceId = ?)').bind(workspaceId),
    db
      .prepare('DELETE FROM "grant" WHERE "id" IN (SELECT "id" FROM "installation" WHERE "workspaceId" = ?)')
      .bind(workspaceId),
    db
      .prepare('DELETE FROM "oauthClient" WHERE "clientId" IN (SELECT "clientId" FROM "app" WHERE "workspaceId" = ?)')
      .bind(workspaceId),
    db.prepare('DELETE FROM apikey WHERE referenceId = ?').bind(workspaceId),
    db.prepare('DELETE FROM "grantWorkspace" WHERE "workspaceId" = ?').bind(workspaceId),
    db.prepare('DELETE FROM organization WHERE id = ?').bind(workspaceId),
  ])

/** What deleting a workspace needs: the auth D1, and a way to erase its agent first (`auth/account.ts`). */
export interface Deletion {
  readonly db: Database
  readonly eraseAgent: (workspaceId: string) => Promise<void>
}

/**
 * Deletes a workspace, by its owner: its agent is erased first (a failure leaves everything as it was, to try again),
 * then its records.
 */
export const deleteWorkspace = async (deletion: Deletion, userId: string, workspaceId: string) => {
  await requireRole(deletion.db, userId, workspaceId, ['owner'])
  await deletion.eraseAgent(workspaceId)
  await removeRecords(deletion.db, workspaceId)
}

/**
 * Before an account goes: every workspace it alone owns is deleted as `deleteWorkspace` deletes one, and its other
 * memberships go with the account itself. While it is the last owner of a workspace other people work in, nothing goes
 * (`Conflict`, `last_owner`, ADR 0093): one of them is made an owner first.
 */
export const deleteOwnedAlone = async (deletion: Deletion, userId: string): Promise<void> => {
  const { results } = await deletion.db
    .prepare(
      `SELECT m.organizationId AS id,
          (SELECT COUNT(*) FROM member p WHERE p.organizationId = m.organizationId) AS members
        FROM member m WHERE m.userId = ? AND m.role = 'owner' AND NOT EXISTS
       (SELECT 1 FROM member o WHERE o.organizationId = m.organizationId AND o.role = 'owner' AND o.userId <> ?)`,
    )
    .bind(userId, userId)
    .all<{ id: string; members: number }>()
  if (results.some(({ members }) => members > 1)) throw new Conflict({ reason: 'last_owner' })
  for (const { id } of results) {
    await deletion.eraseAgent(id)
    await removeRecords(deletion.db, id)
  }
}
