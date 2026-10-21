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

/** The person a Better Auth user record names. */
export const personOf = (user: {
  readonly id: string
  readonly name?: string | null
  readonly email: string
}): Person => ({
  id: user.id,
  name: user.name ?? '',
  email: user.email,
})

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

/**
 * The workspace an OAuth client's sign-in in progress is for (ADR 0089): the person's only one, or once they have
 * chosen (`chosen`: they came back from the choice), the one their session holds while they are its member. None
 * while a person in several has not chosen.
 */
export const signInWorkspace = async (
  db: Database,
  person: Person,
  session: Readonly<Record<string, unknown>>,
  chosen: boolean,
): Promise<string | undefined> => {
  const workspaces = await workspacesOf(db, person, new Date())
  const [only] = workspaces
  if (workspaces.length === 1 && only !== undefined) return only.id
  const active = session['activeOrganizationId']
  return chosen && typeof active === 'string' && workspaces.some((workspace) => workspace.id === active)
    ? active
    : undefined
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
 * Removes a workspace's records once its agent is gone: its keys, the OAuth consents and refresh tokens its members
 * gave clients for it, and the workspace, whose memberships and invitations go with it.
 */
const removeRecords = (db: Database, workspaceId: string, now: Date) =>
  db.batch([
    db.prepare('DELETE FROM apikey WHERE referenceId = ?').bind(workspaceId),
    db.prepare('DELETE FROM oauthConsent WHERE referenceId = ?').bind(workspaceId),
    db
      .prepare('UPDATE oauthRefreshToken SET revoked = ? WHERE referenceId = ? AND revoked IS NULL')
      .bind(now.toISOString(), workspaceId),
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
export const deleteWorkspace = async (deletion: Deletion, userId: string, workspaceId: string, now: Date) => {
  await requireRole(deletion.db, userId, workspaceId, ['owner'])
  await deletion.eraseAgent(workspaceId)
  await removeRecords(deletion.db, workspaceId, now)
}

/**
 * Before an account goes: every workspace it alone owns is deleted as `deleteWorkspace` deletes one. Its other
 * memberships go with the account itself.
 */
export const deleteOwnedAlone = async (deletion: Deletion, userId: string, now: Date): Promise<void> => {
  const { results } = await deletion.db
    .prepare(
      `SELECT m.organizationId AS id FROM member m WHERE m.userId = ? AND m.role = 'owner' AND NOT EXISTS
       (SELECT 1 FROM member o WHERE o.organizationId = m.organizationId AND o.role = 'owner' AND o.userId <> ?)`,
    )
    .bind(userId, userId)
    .all<{ id: string }>()
  for (const { id } of results) {
    await deletion.eraseAgent(id)
    await removeRecords(deletion.db, id, now)
  }
}
