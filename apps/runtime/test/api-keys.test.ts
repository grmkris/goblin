import { type GrantTerms, presetFor } from '@goblin/contracts'
import { InvalidInput, NotFound, Unauthenticated } from '@goblin/contracts/api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createKey, listKeys, revokeKey, rotateKey, updateKey, verifyKey } from '../src/auth/api-keys.ts'
import { handleInboundMcp } from '../src/inbound/route.ts'
import { bearerKey } from '../src/http/api/principal.ts'
import { handleAuth } from '../src/auth/service.ts'
import type { RuntimeEnv } from '../src/env.ts'
import { d1Of } from './d1-sqlite.ts'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const APP = 'https://goblin.test'
const NOW = '2026-10-20T00:00:00.000Z'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/**
 * The real auth store (every migration) with two people, each the owner of their own workspace (ADR 0089), under the
 * deployed Better Auth options, reached as D1 is (`d1Of`).
 */
const fixture = () => {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  for (const name of readdirSync(DIR)
    .filter((file) => file.endsWith('.sql'))
    .toSorted())
    db.exec(readFileSync(join(DIR, name), 'utf8'))
  for (const [user, workspace] of [
    ['u1', 'w1'],
    ['u2', 'w2'],
  ] as const)
    db.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('${user}', '${user}', '${user}@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('${workspace}', '${workspace}', '${workspace}', '${NOW}');
      INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES ('m-${user}', '${workspace}', '${user}', 'owner', '${NOW}')`)
  const env: RuntimeEnv = Object.assign(Object.create(null), {
    APP_URL: APP,
    BETTER_AUTH_SECRET: 'api-key-fixture-secret-at-least-32-characters',
    AUTH_DB: d1Of(db),
  })
  return { db, env }
}

/** A grant's terms for workspace `workspace`: `write` over everything, `inspect`, until revoked, unless `changes` say. */
const terms = (workspace: string, changes: Partial<GrantTerms> = {}): GrantTerms => ({
  ...presetFor('service-dev', [workspace]),
  extras: ['inspect'],
  ...changes,
})
const KEY = { name: 'service-dev', terms: terms('w1') }
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Unauthenticated ? error.reason : error),
  )

/** Why `promise` was refused as invalid input, or the failure itself when it was something else. */
const invalidFor = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof InvalidInput ? error.reason : error),
  )

/** A key's terms over `w1` listing `ids` as its Topics and no Persona. */
const listing = (ids: readonly string[]) =>
  terms('w1', {
    reach: {
      workspaces: 'list',
      each: [
        {
          workspace: 'w1',
          topics: { kind: 'list', ids },
          personas: { kind: 'list', ids: [] },
          connections: { kind: 'all' },
        },
      ],
      origins: [],
    },
  })

describe('server API keys (ADRs 0081, 0114)', () => {
  it('makes a hashed gbk_ key and its grant, whose secret admits its workspace as its credential, once shown', async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    expect(secret).toMatch(/^gbk_[A-Za-z]{64}$/u)
    expect(key).toMatchObject({ name: 'service-dev', grantId: key.id, terms: KEY.terms })
    expect(key.start).toBe(secret.slice(0, 10))
    expect(key.expiresAt).toBeUndefined()
    const stored = db.prepare('SELECT key, referenceId, metadata, permissions, expiresAt FROM apikey').get()
    expect(stored?.['referenceId']).toBe('w1')
    expect(JSON.parse(String(stored?.['metadata']))).toEqual({ createdBy: 'u1' })
    expect([stored?.['permissions'], stored?.['expiresAt']]).toEqual([null, null])
    expect(stored?.['key']).not.toContain(secret.slice(4))
    expect(await verifyKey(env, secret)).toEqual({
      workspaceId: 'w1',
      credential: {
        kind: 'key',
        id: key.id,
        name: 'service-dev',
        grantId: key.id,
        level: 'write',
        extras: ['inspect'],
        expiresAt: null,
        ws: { workspace: 'w1', topics: 'all', personas: 'all', connections: 'all', generation: expect.any(Number) },
        origins: [],
      },
    })
    expect(await listKeys(env, 'w1')).toEqual([expect.objectContaining({ id: key.id, name: 'service-dev' })])
    expect(JSON.stringify(await listKeys(env, 'w1'))).not.toContain(secret)
    expect(await listKeys(env, 'w2')).toEqual([])
  })

  it('makes no key for a workspace the person is not a member of, and its grant reaches only its own', async () => {
    const { db, env } = fixture()
    await expect(createKey(env, 'w2', 'u1', KEY)).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM apikey').get()).toEqual({ count: 0 })
    const elsewhere = { name: 'x', terms: terms('w2', { reach: { workspaces: 'all', each: [], origins: [] } }) }
    const { key } = await createKey(env, 'w1', 'u1', elsewhere)
    expect(key.terms.reach.workspaces).toBe('list')
    expect(key.terms.reach.each.map((each) => each.workspace)).toEqual(['w1'])
  })

  it('gives a key new terms in place: the same id and secret, a new generation, and only in its own workspace', async () => {
    const { env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    const first = (await verifyKey(env, secret)).credential.ws.generation
    const listed = terms('w1', {
      level: 'manage',
      reach: {
        workspaces: 'list',
        each: [
          {
            workspace: 'w1',
            topics: { kind: 'list', ids: ['2'] },
            personas: { kind: 'all' },
            connections: { kind: 'all' },
          },
        ],
        origins: [],
      },
    })
    const { before, after } = await updateKey(env, 'w1', 'u1', key.id, { terms: listed })
    expect(before.terms.level).toBe('write')
    expect(after).toMatchObject({ id: key.id, name: 'service-dev', terms: { level: 'manage' } })
    const now = (await verifyKey(env, secret)).credential
    expect(now).toMatchObject({ id: key.id, level: 'manage', ws: { topics: 'list' } })
    expect(now.ws.generation).toBeGreaterThan(first)
    await expect(updateKey(env, 'w2', 'u2', key.id, { terms: KEY.terms })).rejects.toBeInstanceOf(NotFound)
    expect((await verifyKey(env, secret)).credential.level).toBe('manage')
  })

  it('keeps a list of hundreds of ids in a handful of statements, and replaces it whole', async () => {
    const { db, env } = fixture()
    const { key } = await createKey(env, 'w1', 'u1', KEY)
    const many = Array.from({ length: 500 }, (_, index) => String(index + 1))
    await updateKey(env, 'w1', 'u1', key.id, { terms: listing(many) })
    const count = () => db.prepare('SELECT COUNT(*) AS count FROM grantReach WHERE grantId = ?').get(key.id)
    expect(count()).toEqual({ count: 500 })
    const { after } = await updateKey(env, 'w1', 'u1', key.id, { terms: listing(['7', '7', '9']) })
    expect(count()).toEqual({ count: 2 })
    expect(after.terms.reach.each[0]).toMatchObject({
      topics: { kind: 'list', ids: ['7', '9'] },
      personas: { kind: 'list', ids: [] },
    })
  })

  it('ends a key when its grant does, and gives none of `keys` but by an owner', async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', { ...KEY, terms: terms('w1', { lifetime: '1d' }) })
    expect(Date.parse(key.expiresAt ?? '') - Date.now()).toBeGreaterThan(23 * 3_600_000)
    db.prepare('UPDATE "grant" SET expiresAt = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', key.id)
    expect(await refusal(verifyKey(env, secret))).toBe('grant_expired')
    db.exec(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-a', 'w1', 'u2', 'admin', '${NOW}')`,
    )
    const keys = { ...KEY, terms: terms('w1', { extras: ['keys'] }) }
    await expect(createKey(env, 'w1', 'u2', keys)).rejects.toMatchObject({ _tag: 'Forbidden', reason: 'role' })
    expect((await createKey(env, 'w1', 'u1', keys)).key.terms.extras).toEqual(['keys'])
  })

  it('rotates a key in place: a new secret admits as the same key, the old one no more, at once (ADR 0105)', async () => {
    const { db, env } = fixture()
    const origins = [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit'] }]
    const withOrigins = terms('w1', { reach: { ...KEY.terms.reach, origins } })
    const { key, secret } = await createKey(env, 'w1', 'u1', { ...KEY, terms: withOrigins })
    const rotated = await rotateKey(env, 'w1', key.id)
    expect(rotated.secret).toMatch(/^gbk_[A-Za-z]{64}$/u)
    expect(rotated.secret).not.toBe(secret)
    expect(rotated.key).toEqual({ ...key, start: rotated.secret.slice(0, 10) })
    expect(await refusal(verifyKey(env, secret))).toBe('key')
    expect((await verifyKey(env, rotated.secret)).credential).toMatchObject({ id: key.id, origins })
    // One row, still its maker's, holding only the new secret's hash.
    const rows = db.prepare('SELECT id, key, metadata FROM apikey').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['id']).toBe(key.id)
    expect(JSON.parse(String(rows[0]?.['metadata']))).toMatchObject({ createdBy: 'u1' })
    expect(rows[0]?.['key']).not.toContain(rotated.secret.slice(4))
  })

  it("rotates no key of another workspace's, nor one revoked or whose grant ended", async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    await expect(rotateKey(env, 'w2', key.id)).rejects.toBeInstanceOf(NotFound)
    expect((await verifyKey(env, secret)).credential.id).toBe(key.id)
    const expired = await createKey(env, 'w1', 'u1', KEY)
    db.prepare('UPDATE "grant" SET expiresAt = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', expired.key.id)
    await expect(rotateKey(env, 'w1', expired.key.id)).rejects.toBeInstanceOf(NotFound)
    await revokeKey(env, 'w1', key.id)
    await expect(rotateKey(env, 'w1', key.id)).rejects.toBeInstanceOf(NotFound)
    expect(db.prepare('SELECT COUNT(*) AS count FROM "grant" WHERE id = ?').get(key.id)).toEqual({ count: 0 })
  })

  it('keeps the MCP origins its grant names, normalized, and refuses origins no key may hold', async () => {
    const { env } = fixture()
    const origins = [{ origin: 'https://MCP.swarmm.app/', tools: ['job_submit', 'job_status'] }]
    const { key, secret } = await createKey(env, 'w1', 'u1', {
      ...KEY,
      terms: terms('w1', { reach: { ...KEY.terms.reach, origins } }),
    })
    const granted = [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit', 'job_status'] }]
    expect(key.terms.reach.origins).toEqual(granted)
    expect((await verifyKey(env, secret)).credential.origins).toEqual(granted)
    const local = [{ origin: 'https://10.0.0.2', tools: ['job_submit'] }]
    const refused = { ...KEY, terms: terms('w1', { reach: { ...KEY.terms.reach, origins: local } }) }
    expect(await invalidFor(createKey(env, 'w1', 'u1', refused))).toBe('key_origin')
    const everything = [{ origin: 'https://mcp.swarmm.app', tools: ['all'] }]
    const widened = terms('w1', { reach: { ...KEY.terms.reach, origins: everything } })
    expect(await invalidFor(updateKey(env, 'w1', 'u1', key.id, { terms: widened }))).toBe('key_origin_tools')
    expect((await verifyKey(env, secret)).credential.origins).toEqual(granted)
  })

  it("keeps admitting a key whose plugin counter is full: its rate limit is its agent's (ADR 0085)", async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    db.prepare(
      'UPDATE apikey SET rateLimitEnabled = 1, rateLimitTimeWindow = 60000, rateLimitMax = 600, requestCount = 600, lastRequest = ? WHERE id = ?',
    ).run(new Date().toISOString(), key.id)
    expect((await verifyKey(env, secret)).credential.id).toBe(key.id)
  })

  it('answers /mcp for a key that does not admit with its typed refusal, which the Worker renders', async () => {
    const { env } = fixture()
    const request = new Request(`${APP}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer gbk_${'x'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    await expect(handleInboundMcp(request, env)).rejects.toMatchObject({ _tag: 'Unauthenticated', reason: 'key' })
  })

  it('refuses an unknown or revoked key, and one whose workspace is gone', async () => {
    const { db, env } = fixture()
    expect(await refusal(verifyKey(env, `gbk_${'x'.repeat(64)}`))).toBe('key')
    const revoked = await createKey(env, 'w1', 'u1', KEY)
    await revokeKey(env, 'w2', revoked.key.id)
    expect((await verifyKey(env, revoked.secret)).workspaceId).toBe('w1')
    await revokeKey(env, 'w1', revoked.key.id)
    expect(await refusal(verifyKey(env, revoked.secret))).toBe('key')
    const orphan = await createKey(env, 'w2', 'u2', { ...KEY, terms: terms('w2') })
    db.exec("PRAGMA foreign_keys = ON; DELETE FROM organization WHERE id = 'w2'")
    expect(await refusal(verifyKey(env, orphan.secret))).toBe('key')
  })

  it('tells a gbk_ bearer from any other Authorization header', () => {
    const bearer = (value: string) => new Request(APP, { headers: { authorization: value } })
    expect(bearerKey(bearer(`Bearer gbk_${'a'.repeat(64)}`))).toBe(`gbk_${'a'.repeat(64)}`)
    expect(bearerKey(bearer('Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'))).toBeUndefined()
    expect(bearerKey(bearer('Bearer gbk_short'))).toBeUndefined()
    expect(bearerKey(bearer(`Basic gbk_${'a'.repeat(64)}`))).toBeUndefined()
    expect(bearerKey(new Request(APP))).toBeUndefined()
  })

  it("serves none of the key, workspace and OAuth client plugins' own management routes (ADR 0118)", async () => {
    const { env } = fixture()
    const paths = [
      ...['create', 'list', 'get', 'update', 'delete', 'verify'].map((path) => `api-key/${path}`),
      ...['create', 'list', 'set-active', 'invite-member', 'accept-invitation', 'add-member', 'update'].map(
        (path) => `organization/${path}`,
      ),
      ...['create-client', 'update-client', 'delete-client', 'get-client', 'get-clients', 'client/rotate-secret'].map(
        (path) => `oauth2/${path}`,
      ),
      'admin/oauth2/create-client',
      'admin/oauth2/update-client',
    ]
    for (const path of paths) {
      const response = await handleAuth(
        new Request(`${APP}/api/auth/${path}`, { method: 'POST', headers: { origin: APP } }),
        env,
      )
      expect(response.status, path).toBe(404)
    }
  })
})
