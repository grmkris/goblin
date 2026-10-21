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
  signInWorkspace,
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

  it('deletes a workspace for its owner: its agent first, then its keys, consents and memberships', async () => {
    const { db, sqlite } = fixture()
    const made = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    sqlite.exec(`
      INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt) VALUES ('k1', 'default', '${made.id}', 'h', 'x', 'x');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]');
      INSERT INTO oauthConsent (id, clientId, userId, referenceId, scopes, createdAt, updatedAt)
        VALUES ('consent-1', 'client-1', 'u-kris', '${made.id}', '[]', 'x', 'x');
    `)
    const failing = agents(made.id)
    await expect(deleteWorkspace({ db, eraseAgent: failing.eraseAgent }, KRIS.id, made.id, NOW)).rejects.toThrow()
    expect(count(sqlite, 'organization')).toBe(1)
    expect(count(sqlite, 'apikey')).toBe(1)
    const working = agents()
    await expect(deleteWorkspace({ db, eraseAgent: working.eraseAgent }, ANA.id, made.id, NOW)).rejects.toEqual(
      new NotFound({ what: 'workspace' }),
    )
    await deleteWorkspace({ db, eraseAgent: working.eraseAgent }, KRIS.id, made.id, NOW)
    expect(working.erased).toEqual([made.id])
    for (const table of ['organization', 'member', 'apikey', 'oauthConsent'])
      expect(count(sqlite, table), table).toBe(0)
  })

  it('deletes, before an account goes, only the workspaces it alone owns', async () => {
    const { db, sqlite } = fixture()
    const alone = await createWorkspace(db, KRIS.id, { name: 'Mine', slug: 'mine' }, NOW)
    const shared = await createWorkspace(db, KRIS.id, { name: 'Ours', slug: 'ours' }, NOW)
    sqlite
      .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', ?, ?, 'owner', ?)")
      .run(shared.id, ANA.id, NOW.toISOString())
    const { erased, eraseAgent } = agents()
    await deleteOwnedAlone({ db, eraseAgent }, KRIS.id, NOW)
    expect(erased).toEqual([alone.id])
    expect(await membershipOf(db, ANA.id, shared.id)).toMatchObject({ name: 'Ours', role: 'owner' })
  })

  it('names the workspace an OAuth sign-in is for: the only one, or the chosen one once chosen', async () => {
    const { db } = fixture()
    const [first] = await workspacesOf(db, KRIS, NOW)
    expect(await signInWorkspace(db, KRIS, {}, false)).toBe(first?.id)
    const second = await createWorkspace(db, KRIS.id, { name: 'Swarmm', slug: 'swarmm' }, NOW)
    expect(await signInWorkspace(db, KRIS, { activeOrganizationId: second.id }, false)).toBeUndefined()
    expect(await signInWorkspace(db, KRIS, { activeOrganizationId: second.id }, true)).toBe(second.id)
    const foreign = await createWorkspace(db, ANA.id, { name: 'Ana', slug: 'ana' }, NOW)
    expect(await signInWorkspace(db, KRIS, { activeOrganizationId: foreign.id }, true)).toBeUndefined()
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
