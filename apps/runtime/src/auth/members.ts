import type {
  InvitationPreview,
  InvitationState,
  InvitationView,
  MemberView,
  WorkspaceRole,
  WorkspaceView,
} from '@goblin/contracts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'
import { canonicalEmail } from './signup.ts'
import { type Person, membershipOf } from './workspaces.ts'

/**
 * A workspace's members and invitations (ADR 0093) in the organization() plugin's `member` and `invitation` tables.
 * Owners and admins invite, change roles and remove; only an owner makes, unmakes or removes an owner or an admin,
 * and a workspace always keeps one owner. An invitation is for one address, for seven days; its ID, 128 random bits,
 * is its link, and only a session of that address joins with it. A change that spans rows is one D1 batch.
 */

type Database = RuntimeEnv['AUTH_DB']

/** How long an invitation waits. */
const INVITATION_DAYS = 7
const DAY_MS = 86_400_000

const ROLES: readonly string[] = ['owner', 'admin', 'member'] satisfies readonly WorkspaceRole[]
const roleOf = (role: string | null): WorkspaceRole =>
  // SAFETY: checked against the roles just above; goblin writes no other.
  (role !== null && ROLES.includes(role) ? role : 'member') as WorkspaceRole

const newId = (): string => crypto.randomUUID().replaceAll('-', '')
const later = (now: Date): string => new Date(now.getTime() + INVITATION_DAYS * DAY_MS).toISOString()

interface MemberRow {
  readonly userId: string
  readonly name: string
  readonly email: string
  readonly role: string
  readonly createdAt: string | number
}

const iso = (value: string | number): string => new Date(value).toISOString()

const memberOf = (row: MemberRow): MemberView => ({
  userId: row.userId,
  name: row.name,
  email: row.email,
  role: roleOf(row.role),
  joinedAt: iso(row.createdAt),
})

/** Every member of a workspace, owners first, then admins, then members, each by when they joined. */
export const membersOf = async (db: Database, workspaceId: string): Promise<readonly MemberView[]> =>
  (
    await db
      .prepare(
        `SELECT m.userId AS userId, u.name AS name, u.email AS email, m.role AS role, m.createdAt AS createdAt
           FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.createdAt, m.userId`,
      )
      .bind(workspaceId)
      .all<MemberRow>()
  ).results.map(memberOf)

const owners = async (db: Database, workspaceId: string): Promise<number> =>
  (
    await db
      .prepare("SELECT COUNT(*) AS count FROM member WHERE organizationId = ? AND role = 'owner'")
      .bind(workspaceId)
      .first<{ count: number }>()
  )?.count ?? 0

/** The member of `workspaceId` with `userId`, or `NotFound`. */
const targetOf = async (db: Database, workspaceId: string, userId: string): Promise<MemberView> => {
  const target = (await membersOf(db, workspaceId)).find((member) => member.userId === userId)
  if (target === undefined) throw new NotFound({ what: 'member' })
  return target
}

/** Whether `actor` may change or remove `target`: an admin only a member; an owner anyone. */
const governs = (actor: WorkspaceView, target: WorkspaceRole): boolean =>
  actor.role === 'owner' || (actor.role === 'admin' && target === 'member')

/**
 * Ends `userId`'s membership, and takes the workspace out of the grants they gave MCP clients (ADRs 0097, 0114): a grant
 * of all of theirs drops it with the membership, and joining again never brings back one that named it.
 */
const endMembership = (db: Database, workspaceId: string, userId: string) =>
  db.batch([
    db.prepare('DELETE FROM member WHERE organizationId = ? AND userId = ?').bind(workspaceId, userId),
    db
      .prepare(
        `DELETE FROM "grantWorkspace" WHERE "workspaceId" = ?
          AND "grantId" IN (SELECT "id" FROM "grant" WHERE "kind" = 'client' AND "userId" = ?)`,
      )
      .bind(workspaceId, userId),
  ])

/**
 * A member's new role, by `actor` (the workspace's member making the change): an owner or admin, who governs the
 * target and the role it gets (`governs`); the last owner stays one (`Conflict`, `last_owner`).
 */
export const updateMemberRole = async (
  db: Database,
  actor: WorkspaceView,
  userId: string,
  role: WorkspaceRole,
): Promise<MemberView> => {
  const target = await targetOf(db, actor.id, userId)
  if (!governs(actor, target.role) || !governs(actor, role)) throw new Forbidden({ reason: 'role' })
  if (target.role === 'owner' && role !== 'owner' && (await owners(db, actor.id)) <= 1)
    throw new Conflict({ reason: 'last_owner' })
  await db
    .prepare('UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?')
    .bind(role, actor.id, userId)
    .run()
  return { ...target, role }
}

/** Removes a member, by `actor` as `updateMemberRole` decides who may; never the last owner, nor oneself (leave). */
export const removeMember = async (db: Database, actor: WorkspaceView, actorId: string, userId: string) => {
  if (userId === actorId) throw new Conflict({ reason: 'leave' })
  const target = await targetOf(db, actor.id, userId)
  if (!governs(actor, target.role)) throw new Forbidden({ reason: 'role' })
  if (target.role === 'owner' && (await owners(db, actor.id)) <= 1) throw new Conflict({ reason: 'last_owner' })
  await endMembership(db, actor.id, userId)
}

/** Ends the signed-in person's own membership; the last owner cannot leave (`Conflict`, `last_owner`). */
export const leaveWorkspace = async (db: Database, workspace: WorkspaceView, userId: string) => {
  if (workspace.role === 'owner' && (await owners(db, workspace.id)) <= 1) throw new Conflict({ reason: 'last_owner' })
  await endMembership(db, workspace.id, userId)
}

interface InvitationRow {
  readonly id: string
  readonly email: string
  readonly role: string | null
  readonly status: string
  readonly expiresAt: string | number
  readonly inviter: string
  readonly workspace: string
  readonly organizationId: string
}

/** An invitation's state; a status goblin does not write is one that no longer waits, never one that does. */
const stateOf = (row: InvitationRow, now: Date): InvitationState => {
  if (row.status === 'pending') return new Date(row.expiresAt).getTime() <= now.getTime() ? 'expired' : 'pending'
  return row.status === 'accepted' || row.status === 'declined' ? row.status : 'canceled'
}

const INVITATION = `SELECT i.id AS id, i.email AS email, i.role AS role, i.status AS status, i.expiresAt AS expiresAt,
    i.organizationId AS organizationId, o.name AS workspace,
    CASE WHEN trim(u.name) = '' THEN u.email ELSE u.name END AS inviter
  FROM invitation i JOIN organization o ON o.id = i.organizationId JOIN user u ON u.id = i.inviterId`

const viewOf = (row: InvitationRow, now: Date): InvitationView => ({
  id: row.id,
  email: row.email,
  role: roleOf(row.role),
  state: stateOf(row, now),
  invitedBy: row.inviter,
  expiresAt: iso(row.expiresAt),
})

const previewOf = (row: InvitationRow, now: Date): InvitationPreview => ({
  id: row.id,
  workspace: row.workspace,
  invitedBy: row.inviter,
  email: row.email,
  role: roleOf(row.role),
  state: stateOf(row, now),
})

/** A workspace's invitations still waiting, newest first. */
export const invitationsOf = async (db: Database, workspaceId: string, now: Date): Promise<readonly InvitationView[]> =>
  (
    await db
      .prepare(`${INVITATION} WHERE i.organizationId = ? AND i.status = 'pending' AND i.expiresAt > ?
                ORDER BY i.createdAt DESC`)
      .bind(workspaceId, now.toISOString())
      .all<InvitationRow>()
  ).results.map((row) => viewOf(row, now))

/** One invitation, as its link shows it; `NotFound` for an ID that names none. */
export const invitationPreview = async (db: Database, id: string, now: Date): Promise<InvitationPreview> => {
  const row = await db.prepare(`${INVITATION} WHERE i.id = ?`).bind(id).first<InvitationRow>()
  if (row === null) throw new NotFound({ what: 'invitation' })
  return previewOf(row, now)
}

/** The invitations waiting for `email`, newest first. */
export const invitationsFor = async (db: Database, email: string, now: Date): Promise<readonly InvitationPreview[]> =>
  (
    await db
      .prepare(`${INVITATION} WHERE i.email = ? AND i.status = 'pending' AND i.expiresAt > ? ORDER BY i.createdAt DESC`)
      .bind(canonicalEmail(email), now.toISOString())
      .all<InvitationRow>()
  ).results.map((row) => previewOf(row, now))

/** Whether an invitation waits for `email`: what lets an address with no account sign up when sign-up is closed. */
export const invitedEmail = async (db: Database, email: string, now: Date): Promise<boolean> =>
  (await invitationsFor(db, email, now)).length > 0

/**
 * Invitations to `actor`'s workspace for `emails`, each with `role` and from `inviterId`: one per address, replacing
 * one still waiting for it. An address that is already a member's refuses them all (`Conflict`, `member`).
 */
export const inviteMembers = async (
  db: Database,
  actor: WorkspaceView,
  inviterId: string,
  input: { readonly emails: readonly string[]; readonly role: 'admin' | 'member' },
  now: Date,
): Promise<readonly InvitationView[]> => {
  if (input.role === 'admin' && actor.role !== 'owner') throw new Forbidden({ reason: 'role' })
  const emails = [...new Set(input.emails.map(canonicalEmail))]
  const members = new Set((await membersOf(db, actor.id)).map((member) => canonicalEmail(member.email)))
  if (emails.some((email) => members.has(email))) throw new Conflict({ reason: 'member' })
  const made = emails.map((email) => ({ id: newId(), email }))
  await db.batch(
    made.flatMap(({ id, email }) => [
      db
        .prepare(
          "UPDATE invitation SET status = 'canceled' WHERE organizationId = ? AND email = ? AND status = 'pending'",
        )
        .bind(actor.id, email),
      db
        .prepare(
          `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .bind(id, actor.id, email, input.role, later(now), now.toISOString(), inviterId),
    ]),
  )
  const views = await invitationsOf(db, actor.id, now)
  return made.flatMap(({ id }) => views.filter((view) => view.id === id))
}

/** Withdraws one of the workspace's invitations still waiting; one that is not is left as it is. */
export const cancelInvitation = async (db: Database, workspaceId: string, id: string): Promise<void> => {
  await db
    .prepare("UPDATE invitation SET status = 'canceled' WHERE id = ? AND organizationId = ? AND status = 'pending'")
    .bind(id, workspaceId)
    .run()
}

/**
 * One of `actor`'s workspace's invitations, waiting for seven days from now: `NotFound` when it is not waiting any more,
 * and an admin's invitation only an owner renews (`Forbidden`), as only an owner makes one.
 */
export const renewInvitation = async (
  db: Database,
  actor: WorkspaceView,
  id: string,
  now: Date,
): Promise<InvitationView> => {
  const waiting = (await invitationsOf(db, actor.id, now)).find((view) => view.id === id)
  if (waiting === undefined) throw new NotFound({ what: 'invitation' })
  if (waiting.role === 'admin' && actor.role !== 'owner') throw new Forbidden({ reason: 'role' })
  const expiresAt = later(now)
  await db
    .prepare(
      "UPDATE invitation SET expiresAt = ? WHERE id = ? AND organizationId = ? AND status = 'pending' AND expiresAt > ?",
    )
    .bind(expiresAt, id, actor.id, now.toISOString())
    .run()
  return { ...waiting, expiresAt }
}

/** The workspace an invitation is for, if it names one. */
export const invitationWorkspace = async (db: Database, id: string): Promise<string | undefined> =>
  (await db.prepare('SELECT organizationId FROM invitation WHERE id = ?').bind(id).first<string>('organizationId')) ??
  undefined

/** The invitation `id` for `person`: it must be for their address (`Forbidden`) and still wait (`Conflict`). */
const waitingFor = async (db: Database, person: Person, id: string, now: Date) => {
  const row = await db.prepare(`${INVITATION} WHERE i.id = ?`).bind(id).first<InvitationRow>()
  if (row === null) throw new NotFound({ what: 'invitation' })
  if (canonicalEmail(row.email) !== canonicalEmail(person.email)) throw new Forbidden({ reason: 'invitation_email' })
  const state = stateOf(row, now)
  if (state !== 'pending') throw new Conflict({ reason: state })
  return row
}

/**
 * Joins `person` to the workspace an invitation is for, with its role, in one batch that adds the membership only while
 * the invitation still waits (one canceled or replaced meanwhile adds none); joining again is no second membership.
 * The workspace they joined.
 */
export const acceptInvitation = async (db: Database, person: Person, id: string, now: Date): Promise<WorkspaceView> => {
  const row = await waitingFor(db, person, id, now)
  const at = now.toISOString()
  await db.batch([
    db
      .prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)
           AND EXISTS (SELECT 1 FROM invitation WHERE id = ? AND status = 'pending' AND expiresAt > ?)`,
      )
      .bind(newId(), row.organizationId, person.id, roleOf(row.role), at, row.organizationId, person.id, id, at),
    db.prepare("UPDATE invitation SET status = 'accepted' WHERE id = ? AND status = 'pending'").bind(id),
  ])
  const joined = await membershipOf(db, person.id, row.organizationId)
  if (joined !== undefined) return joined
  await waitingFor(db, person, id, now)
  throw new NotFound({ what: 'workspace' })
}

/** Turns an invitation down, for the person it is for. */
export const declineInvitation = async (db: Database, person: Person, id: string, now: Date): Promise<void> => {
  await waitingFor(db, person, id, now)
  await db.prepare("UPDATE invitation SET status = 'declined' WHERE id = ? AND status = 'pending'").bind(id).run()
}
