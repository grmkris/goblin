import { Conflict, Forbidden, NotFound } from '@goblin/contracts/api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptInvitation,
  declineInvitation,
  invitationPreview,
  invitationsFor,
  invitationsOf,
  invitedEmail,
  inviteMembers,
  leaveWorkspace,
  membersOf,
  removeMember,
  renewInvitation,
  updateMemberRole,
} from '../src/auth/members.ts'
import { createWorkspace, membershipOf, workspacesOf } from '../src/auth/workspaces.ts'
import { d1Of } from './d1-sqlite.ts'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const NOW = new Date('2026-10-21T08:00:00.000Z')
const WEEK_LATER = new Date('2026-10-28T08:00:01.000Z')
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const KRIS = { id: 'u-kris', name: 'Kris', email: 'kris@example.test' }
const ANA = { id: 'u-ana', name: 'Ana', email: 'ana@example.test' }
const BO = { id: 'u-bo', name: '', email: 'bo@example.test' }

/** The real auth store (every migration), its three people, and Kris's workspace, which he owns. */
const fixture = async () => {
  const sqlite = new DatabaseSync(':memory:')
  databases.push(sqlite)
  for (const name of readdirSync(DIR)
    .filter((file) => file.endsWith('.sql'))
    .toSorted())
    sqlite.exec(readFileSync(join(DIR, name), 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const person of [KRIS, ANA, BO])
    sqlite
      .prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .run(person.id, person.name, person.email, NOW.toISOString(), NOW.toISOString())
  const db = d1Of(sqlite)
  const workspace = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
  return { sqlite, db, workspace }
}

/** Ana as a member of the workspace, through an invitation she takes. */
const withAna = async (role: 'admin' | 'member' = 'member') => {
  const built = await fixture()
  const [invitation] = await inviteMembers(built.db, built.workspace, KRIS.id, { emails: [ANA.email], role }, NOW)
  if (invitation === undefined) throw new Error('no invitation')
  const joined = await acceptInvitation(built.db, ANA, invitation.id, NOW)
  return { ...built, joined }
}

describe('invitations (ADR 0093)', () => {
  it('invites an address for seven days, which its person sees, previews and takes with the role it carries', async () => {
    const { db, workspace } = await fixture()
    const [invitation] = await inviteMembers(
      db,
      workspace,
      KRIS.id,
      { emails: [' Ana@Example.test '], role: 'member' },
      NOW,
    )
    expect(invitation).toMatchObject({ email: 'ana@example.test', role: 'member', state: 'pending', invitedBy: 'Kris' })
    expect(invitation?.id).toMatch(/^[a-f0-9]{32}$/u)
    expect(invitation?.expiresAt).toBe('2026-10-28T08:00:00.000Z')
    expect(await invitedEmail(db, 'ANA@example.test', NOW)).toBe(true)
    expect(await invitationsFor(db, ANA.email, NOW)).toEqual([
      expect.objectContaining({ workspace: 'Swarmm', invitedBy: 'Kris', state: 'pending' }),
    ])
    const id = invitation?.id ?? ''
    expect(await invitationPreview(db, id, NOW)).toMatchObject({ workspace: 'Swarmm', email: 'ana@example.test' })
    expect(await acceptInvitation(db, ANA, id, NOW)).toMatchObject({ id: workspace.id, name: 'Swarmm', role: 'member' })
    expect((await membersOf(db, workspace.id)).map((member) => [member.name, member.role])).toEqual([
      ['Kris', 'owner'],
      ['Ana', 'member'],
    ])
    expect(await invitationsOf(db, workspace.id, NOW)).toEqual([])
    await expect(acceptInvitation(db, ANA, id, NOW)).rejects.toEqual(new Conflict({ reason: 'accepted' }))
  })

  it('lets only the address it is for take or turn it down, and only while it waits', async () => {
    const { db, workspace } = await fixture()
    const [invitation] = await inviteMembers(db, workspace, KRIS.id, { emails: [ANA.email], role: 'member' }, NOW)
    const id = invitation?.id ?? ''
    await expect(acceptInvitation(db, BO, id, NOW)).rejects.toEqual(new Forbidden({ reason: 'invitation_email' }))
    await expect(acceptInvitation(db, ANA, id, WEEK_LATER)).rejects.toEqual(new Conflict({ reason: 'expired' }))
    expect(await invitedEmail(db, ANA.email, WEEK_LATER)).toBe(false)
    await declineInvitation(db, ANA, id, NOW)
    expect((await invitationPreview(db, id, NOW)).state).toBe('declined')
    await expect(invitationPreview(db, 'f'.repeat(32), NOW)).rejects.toEqual(new NotFound({ what: 'invitation' }))
  })

  it("replaces an address's waiting invitation, refuses a member's, and leaves admins to owners", async () => {
    const { db, workspace } = await withAna()
    const first = await inviteMembers(db, workspace, KRIS.id, { emails: [BO.email], role: 'member' }, NOW)
    const second = await inviteMembers(db, workspace, KRIS.id, { emails: [BO.email], role: 'member' }, NOW)
    expect((await invitationsOf(db, workspace.id, NOW)).map((each) => each.id)).toEqual(second.map((each) => each.id))
    expect((await invitationPreview(db, first[0]?.id ?? '', NOW)).state).toBe('canceled')
    await expect(inviteMembers(db, workspace, KRIS.id, { emails: [ANA.email], role: 'member' }, NOW)).rejects.toEqual(
      new Conflict({ reason: 'member' }),
    )
    const admin = { ...workspace, role: 'admin' as const }
    await expect(inviteMembers(db, admin, ANA.id, { emails: [BO.email], role: 'admin' }, NOW)).rejects.toEqual(
      new Forbidden({ reason: 'role' }),
    )
  })

  it("renews only an invitation still waiting, and an admin's only for an owner", async () => {
    const { db, workspace } = await withAna('admin')
    const [made] = await inviteMembers(db, workspace, KRIS.id, { emails: [BO.email], role: 'admin' }, NOW)
    const id = made?.id ?? ''
    const ana = { ...workspace, role: 'admin' as const }
    await expect(renewInvitation(db, ana, id, NOW)).rejects.toEqual(new Forbidden({ reason: 'role' }))
    await expect(renewInvitation(db, workspace, id, WEEK_LATER)).rejects.toEqual(new NotFound({ what: 'invitation' }))
    expect((await renewInvitation(db, workspace, id, NOW)).state).toBe('pending')
  })

  it('takes a status goblin does not write for one that no longer waits', async () => {
    const { db, sqlite, workspace } = await fixture()
    const [made] = await inviteMembers(db, workspace, KRIS.id, { emails: [ANA.email], role: 'member' }, NOW)
    sqlite.prepare("UPDATE invitation SET status = 'rejected' WHERE id = ?").run(made?.id ?? '')
    expect((await invitationPreview(db, made?.id ?? '', NOW)).state).toBe('canceled')
    await expect(acceptInvitation(db, ANA, made?.id ?? '', NOW)).rejects.toEqual(new Conflict({ reason: 'canceled' }))
  })

  it('gives a person with an invitation waiting no first workspace of their own, until they have none waiting', async () => {
    const { db, workspace } = await fixture()
    const [invitation] = await inviteMembers(db, workspace, KRIS.id, { emails: [BO.email], role: 'member' }, NOW)
    expect(await workspacesOf(db, BO, NOW)).toEqual([])
    await declineInvitation(db, BO, invitation?.id ?? '', NOW)
    expect(await workspacesOf(db, BO, NOW)).toEqual([
      expect.objectContaining({ name: "bo's workspace", role: 'owner' }),
    ])
  })
})

describe('members and their roles (ADR 0093)', () => {
  it('lets an owner make and unmake admins and owners, an admin only members, and keeps the last owner', async () => {
    const { db, workspace } = await withAna()
    expect((await updateMemberRole(db, workspace, ANA.id, 'admin')).role).toBe('admin')
    const ana = await membershipOf(db, ANA.id, workspace.id)
    if (ana === undefined) throw new Error('no membership')
    await expect(updateMemberRole(db, ana, KRIS.id, 'member')).rejects.toEqual(new Forbidden({ reason: 'role' }))
    await expect(updateMemberRole(db, workspace, KRIS.id, 'member')).rejects.toEqual(
      new Conflict({ reason: 'last_owner' }),
    )
    expect((await updateMemberRole(db, workspace, ANA.id, 'owner')).role).toBe('owner')
    expect((await updateMemberRole(db, workspace, KRIS.id, 'member')).role).toBe('member')
  })

  it("removes a member and takes the workspace out of their clients' grants, never oneself or the last owner", async () => {
    const { db, sqlite, workspace } = await withAna()
    sqlite.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]');
      INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt)
        VALUES ('consent-1', 'client-1', 'u-ana', '[]', 'x', 'x');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u-ana', 'c', 'write', 'x', 'x');
      INSERT INTO grantWorkspace (grantId, workspaceId) VALUES ('cg_1', '${workspace.id}');
    `)
    await expect(removeMember(db, workspace, KRIS.id, KRIS.id)).rejects.toEqual(new Conflict({ reason: 'leave' }))
    await removeMember(db, workspace, KRIS.id, ANA.id)
    expect(await membershipOf(db, ANA.id, workspace.id)).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM grantWorkspace').get()).toEqual({ count: 0 })
    // The consent and the grant are the person's, for whatever else the grant names.
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM oauthConsent').get()).toEqual({ count: 1 })
    await expect(leaveWorkspace(db, workspace, KRIS.id)).rejects.toEqual(new Conflict({ reason: 'last_owner' }))
  })

  it('lets a member leave, and keeps an admin from removing anyone but a member', async () => {
    const { db, workspace, joined } = await withAna('admin')
    await expect(removeMember(db, joined, ANA.id, KRIS.id)).rejects.toEqual(new Forbidden({ reason: 'role' }))
    await leaveWorkspace(db, joined, ANA.id)
    expect((await membersOf(db, workspace.id)).map((member) => member.userId)).toEqual([KRIS.id])
  })
})
