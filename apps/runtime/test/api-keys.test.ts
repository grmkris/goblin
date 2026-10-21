import { NotFound, Unauthenticated } from '@goblin/contracts/api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createKey, listKeys, revokeKey, updateKey, verifyKey } from '../src/auth/api-keys.ts'
import { handleInboundMcp } from '../src/inbound/route.ts'
import { bearerKey } from '../src/http/api/principal.ts'
import { handleAuth } from '../src/auth/service.ts'
import type { RuntimeEnv } from '../src/env.ts'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const APP = 'https://goblin.test'
const NOW = '2026-10-20T00:00:00.000Z'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/**
 * The real auth store (every migration) with two people, each the owner of their own workspace (ADR 0089), under the
 * deployed Better Auth options.
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
    AUTH_DB: db,
  })
  return { db, env }
}

const KEY = { name: 'service-dev', scopes: ['topics', 'conversations'], servers: ['mycut'], expiresInDays: 30 } as const
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Unauthenticated ? error.reason : error),
  )

describe('server API keys (ADR 0081)', () => {
  it('makes a hashed gbk_ key whose secret admits its workspace with its scopes and servers, once shown', async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    expect(secret).toMatch(/^gbk_[A-Za-z]{64}$/u)
    expect(key).toMatchObject({ name: 'service-dev', scopes: ['topics', 'conversations'], servers: ['mycut'] })
    expect(key.start).toBe(secret.slice(0, 10))
    expect(Date.parse(key.expiresAt ?? '') - Date.now()).toBeGreaterThan(29 * 86_400_000)
    const stored = db.prepare('SELECT key, referenceId, metadata FROM apikey').get()
    expect(stored?.['referenceId']).toBe('w1')
    expect(JSON.parse(String(stored?.['metadata']))).toEqual({ servers: ['mycut'], createdBy: 'u1' })
    expect(stored?.['key']).not.toContain(secret.slice(4))
    expect(await verifyKey(env, secret)).toEqual({
      workspaceId: 'w1',
      keyId: key.id,
      scopes: ['topics', 'conversations'],
      servers: ['mycut'],
    })
    expect(await listKeys(env, 'w1')).toEqual([expect.objectContaining({ id: key.id, name: 'service-dev' })])
    expect(JSON.stringify(await listKeys(env, 'w1'))).not.toContain(secret)
    expect(await listKeys(env, 'w2')).toEqual([])
  })

  it('makes no key for a workspace the person is not a member of', async () => {
    const { db, env } = fixture()
    await expect(createKey(env, 'w2', 'u1', KEY)).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM apikey').get()).toEqual({ count: 0 })
  })

  it('gives a key new scopes in place: the same id and secret, and only in its own workspace (ADR 0084)', async () => {
    const { env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    const { before, after } = await updateKey(env, 'w1', 'u1', key.id, { scopes: ['topics', 'inspect', 'inspect'] })
    expect(before.scopes).toEqual(['topics', 'conversations'])
    expect(after).toMatchObject({ id: key.id, name: 'service-dev', scopes: ['topics', 'inspect'], servers: ['mycut'] })
    expect(await verifyKey(env, secret)).toEqual({
      workspaceId: 'w1',
      keyId: key.id,
      scopes: ['topics', 'inspect'],
      servers: ['mycut'],
    })
    await expect(updateKey(env, 'w2', 'u2', key.id, { scopes: ['personas'] })).rejects.toBeInstanceOf(NotFound)
    expect((await verifyKey(env, secret)).scopes).toEqual(['topics', 'inspect'])
  })

  it("keeps admitting a key whose plugin counter is full: its rate limit is its agent's (ADR 0085)", async () => {
    const { db, env } = fixture()
    const { key, secret } = await createKey(env, 'w1', 'u1', KEY)
    db.prepare(
      'UPDATE apikey SET rateLimitEnabled = 1, rateLimitTimeWindow = 60000, rateLimitMax = 600, requestCount = 600, lastRequest = ? WHERE id = ?',
    ).run(new Date().toISOString(), key.id)
    expect((await verifyKey(env, secret)).keyId).toBe(key.id)
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

  it('refuses an unknown, revoked or expired key, and one whose workspace is gone', async () => {
    const { db, env } = fixture()
    expect(await refusal(verifyKey(env, `gbk_${'x'.repeat(64)}`))).toBe('key')
    const revoked = await createKey(env, 'w1', 'u1', KEY)
    await revokeKey(env, 'w2', revoked.key.id)
    expect((await verifyKey(env, revoked.secret)).workspaceId).toBe('w1')
    await revokeKey(env, 'w1', revoked.key.id)
    expect(await refusal(verifyKey(env, revoked.secret))).toBe('key')
    const expired = await createKey(env, 'w1', 'u1', KEY)
    db.prepare('UPDATE apikey SET expiresAt = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', expired.key.id)
    expect(await refusal(verifyKey(env, expired.secret))).toBe('key')
    const orphan = await createKey(env, 'w2', 'u2', KEY)
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

  it("serves none of the key and workspace plugins' own routes", async () => {
    const { env } = fixture()
    const paths = [
      ...['create', 'list', 'get', 'update', 'delete', 'verify'].map((path) => `api-key/${path}`),
      ...['create', 'list', 'set-active', 'invite-member', 'accept-invitation', 'add-member', 'update'].map(
        (path) => `organization/${path}`,
      ),
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
