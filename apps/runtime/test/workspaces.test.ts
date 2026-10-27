import { Conflict, Forbidden, NotFound } from '@goblin/contracts/api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkspace,
  deleteOwnedAlone,
  deleteWorkspace,
  membershipOf,
  reachedBy,
  slugFrom,
  updateWorkspace,
  workspacesOf,
} from '../src/auth/workspaces.ts'
import { d1Of } from './d1-sqlite.ts'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const NOW = new Date('2026-10-21T08:00:00.000Z')
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const byId = (a: string, b: string) => a.localeCompare(b)

const KRIS = { id: 'u-kris', name: 'Kris', email: 'kris.k@example.test' }
const ANA = { id: 'u-ana', name: '', email: 'ana@example.test' }

/** The real auth store (every migration) with two people and no workspace, through D1's own API. */
const fixture = () => {
  const sqlite = new DatabaseSync(':memory:')
  databases.push(sqlite)
  for (const name of readdirSync(DIR)
    .filter((file) => file.endsWith('.sql'))
    .toSorted())
    sqlite.exec(readFileSync(join(DIR, name), 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const person of [KRIS, ANA])
    sqlite
      .prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .run(person.id, person.name, person.email, NOW.toISOString(), NOW.toISOString())
  return { sqlite, db: d1Of(sqlite) }
}

/** Erasing agents, recording each one erased; `failing` names one whose erasure fails. */
const agents = (failing?: string) => {
  const erased: string[] = []
  const eraseAgent = (name: string) => {
    if (name === failing) return Promise.reject(new Error('agent unavailable'))
    erased.push(name)
    return Promise.resolve()
  }
  return { erased, eraseAgent }
}

const count = (sqlite: DatabaseSync, table: string) =>
  Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.['count'])

describe('workspaces (ADR 0089)', () => {
  it('gives a person with none a first one named after them, and finds that same one again', async () => {
    const { db } = fixture()
    const [first] = await workspacesOf(db, KRIS, NOW)
    expect(first).toMatchObject({ name: "Kris's workspace", slug: 'kris-k', role: 'owner' })
    expect(await workspacesOf(db, KRIS, NOW)).toEqual([first])
    expect(await workspacesOf(db, ANA, NOW)).toEqual([
      expect.objectContaining({ name: "ana's workspace", slug: 'ana', role: 'owner' }),
    ])
  })

  it('makes one first workspace for two requests at once, and another slug when the address is taken', async () => {
    const { db, sqlite } = fixture()
    await createWorkspace(db, ANA.id, { name: 'Taken', slug: 'kris-k' }, NOW)
    const [one, two] = await Promise.all([workspacesOf(db, KRIS, NOW), workspacesOf(db, KRIS, NOW)])
    expect(one).toEqual(two)
    expect(one).toHaveLength(1)
    expect(one?.[0]?.slug).toMatch(/^kris-k-[0-9a-f]{4}$/u)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM member WHERE userId = 'u-kris'").get()).toEqual({ count: 1 })
  })

  it('makes a workspace with its maker as owner, and refuses a slug another has', async () => {
    const { db } = fixture()
    const made = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    expect(made).toMatchObject({ name: 'Swarmm', slug: 'swarmm', role: 'owner' })
    expect(await membershipOf(db, KRIS.id, made.id)).toEqual(made)
    expect(await membershipOf(db, ANA.id, made.id)).toBeUndefined()
    await expect(createWorkspace(db, ANA.id, { name: 'Other', slug: 'swarmm' }, NOW)).rejects.toEqual(
      new Conflict({ reason: 'slug' }),
    )
  })

  it('renames a workspace or moves its slug for its owner, and for no one else', async () => {
    const { db, sqlite } = fixture()
    const made = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    await createWorkspace(db, ANA.id, { name: 'Ana', slug: 'ana' }, NOW)
    expect(await updateWorkspace(db, KRIS.id, made.id, { name: 'Swarmm team' })).toMatchObject({
      name: 'Swarmm team',
      slug: 'swarmm',
    })
    await expect(updateWorkspace(db, KRIS.id, made.id, { slug: 'ana' })).rejects.toEqual(
      new Conflict({ reason: 'slug' }),
    )
    await expect(updateWorkspace(db, ANA.id, made.id, { name: 'Mine' })).rejects.toEqual(
      new NotFound({ what: 'workspace' }),
    )
    sqlite
      .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', ?, ?, 'member', ?)")
      .run(made.id, ANA.id, NOW.toISOString())
    await expect(updateWorkspace(db, ANA.id, made.id, { name: 'Mine' })).rejects.toEqual(
      new Forbidden({ reason: 'role' }),
    )
  })

  it("deletes a workspace for its owner: its agent first, then the apps installed in it with their grants, clients' reach of it and memberships", async () => {
    const { db, sqlite } = fixture()
    const made = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    sqlite.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]'), ('c2', 'app-1', '[]');
      INSERT INTO app (clientId, workspaceId, terms, script, createdBy, createdAt) VALUES ('app-1', '${made.id}', '{}', 1, 'u-kris', 'x');
      INSERT INTO "grant" (id, kind, clientId, name, level, createdAt, updatedAt) VALUES ('in_1', 'app', 'app-1', 'a', 'write', 'x', 'x');
      INSERT INTO installation (id, clientId, workspaceId, approvedBy, createdAt) VALUES ('in_1', 'app-1', '${made.id}', 'u-kris', 'x');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u-kris', 'c', 'write', 'x', 'x');
      INSERT INTO grantWorkspace (grantId, workspaceId) VALUES ('in_1', '${made.id}'), ('cg_1', '${made.id}');
    `)
    const failing = agents(made.id)
    await expect(deleteWorkspace({ db, eraseAgent: failing.eraseAgent }, KRIS.id, made.id)).rejects.toThrow()
    expect(count(sqlite, 'organization')).toBe(1)
    expect(count(sqlite, 'installation')).toBe(1)
    const working = agents()
    await expect(deleteWorkspace({ db, eraseAgent: working.eraseAgent }, ANA.id, made.id)).rejects.toEqual(
      new NotFound({ what: 'workspace' }),
    )
    await deleteWorkspace({ db, eraseAgent: working.eraseAgent }, KRIS.id, made.id)
    expect(working.erased).toEqual([made.id])
    for (const table of ['organization', 'member', 'app', 'installation', 'grantWorkspace'])
      expect(count(sqlite, table), table).toBe(0)
    // The client's grant is its person's, for whatever else it reaches; the app's went with its installation.
    expect(sqlite.prepare('SELECT id FROM "grant"').all()).toEqual([{ id: 'cg_1' }])
  })

  it('deletes, before an account goes, only the workspaces it alone owns', async () => {
    const { db, sqlite } = fixture()
    const alone = await createWorkspace(db, KRIS.id, { name: 'Mine', slug: 'mine' }, NOW)
    const shared = await createWorkspace(db, KRIS.id, { name: 'Ours', slug: 'ours' }, NOW)
    sqlite
      .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', ?, ?, 'owner', ?)")
      .run(shared.id, ANA.id, NOW.toISOString())
    const { erased, eraseAgent } = agents()
    await deleteOwnedAlone({ db, eraseAgent }, KRIS.id)
    expect(erased).toEqual([alone.id])
    expect(await membershipOf(db, ANA.id, shared.id)).toMatchObject({ name: 'Ours', role: 'owner' })
  })

  it('lets no account go while it is the last owner of a workspace other people work in (ADR 0093)', async () => {
    const { db, sqlite } = fixture()
    await createWorkspace(db, KRIS.id, { name: 'Mine', slug: 'mine' }, NOW)
    const team = await createWorkspace(db, KRIS.id, { name: 'Team', slug: 'team' }, NOW)
    sqlite
      .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', ?, ?, 'member', ?)")
      .run(team.id, ANA.id, NOW.toISOString())
    const { erased, eraseAgent } = agents()
    await expect(deleteOwnedAlone({ db, eraseAgent }, KRIS.id)).rejects.toEqual(new Conflict({ reason: 'last_owner' }))
    expect(erased).toEqual([])
  })

  it("reaches, for an MCP client, all of a person's workspaces live, or those its grant names while they are a member (ADRs 0097, 0114)", async () => {
    const { db, sqlite } = fixture()
    const [first] = await workspacesOf(db, KRIS, NOW)
    const second = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    const foreign = await createWorkspace(db, ANA.id, { name: 'Ana', slug: 'ana' }, NOW)
    sqlite.exec(`INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]')`)
    expect(await reachedBy(db, KRIS.id, 'client-1')).toBeUndefined()
    sqlite.exec(`
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u-kris', 'c', 'write', 'x', 'x');
      INSERT INTO grantWorkspace (grantId, workspaceId) VALUES ('cg_1', '${second.id}'), ('cg_1', '${foreign.id}');
    `)
    // A listed workspace the person is no member of is never reached.
    expect((await reachedBy(db, KRIS.id, 'client-1'))?.workspaces.map((workspace) => workspace.slug)).toEqual([
      'swarmm',
    ])
    sqlite.exec(`UPDATE "grant" SET "workspacesAll" = 1`)
    const later = await createWorkspace(db, KRIS.id, { name: 'Later', slug: 'later' }, NOW)
    const all = await reachedBy(db, KRIS.id, 'client-1')
    expect(all?.all).toBe(true)
    expect(all?.workspaces.map((workspace) => workspace.id).toSorted(byId)).toEqual(
      [first?.id ?? '', second.id, later.id].toSorted(byId),
    )
    sqlite.exec(`UPDATE "grant" SET "revokedAt" = 'x'`)
    expect(await reachedBy(db, KRIS.id, 'client-1')).toBeUndefined()
  })

  it('makes a slug of lowercase letters, digits and single hyphens, three characters at least', () => {
    expect(slugFrom('Kris.K+goblin')).toBe('kris-k-goblin')
    expect(slugFrom('__swarmm__dev__')).toBe('swarmm-dev')
    expect(slugFrom('a')).toBe('a-ws')
    expect(slugFrom('Ünïcode')).toBe('n-code')
    expect(slugFrom('!!!')).toBe('my-ws')
    expect(slugFrom('x'.repeat(50))).toHaveLength(30)
  })
})
