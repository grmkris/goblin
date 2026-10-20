import { getSchema } from 'better-auth/db'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth/options.ts'
import type { RuntimeEnv } from '../src/env.ts'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const migrations = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .toSorted()
const APP = 'https://goblin.test'
const NOW = '2026-10-15T00:00:00.000Z'
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'goblin:inspect']
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** Better Auth recognizes node:sqlite itself; this fixture supplies the exact deployed options and real baseline. */
const fixture = () => {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  for (const name of migrations) db.exec(readFileSync(join(DIR, name), 'utf8'))
  const env: RuntimeEnv = Object.assign(Object.create(null), {
    APP_URL: APP,
    BETTER_AUTH_SECRET: 'baseline-fixture-secret-at-least-32-characters',
    AUTH_DB: db,
  })
  return { db, auth: createAuth(env, env.AUTH_DB) }
}

/** The indexes actually enforcing constraints, including implicit primary-key and unique indexes. */
const indexes = (db: DatabaseSync, table: string) =>
  db
    .prepare('SELECT name, "unique" AS isUnique FROM pragma_index_list(?)')
    .all(table)
    .map((index) => ({
      unique: index['isUnique'] === 1,
      columns: db
        .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(String(index['name']))
        .map((row) => row['name']),
    }))

const SQL_TYPES: Readonly<Record<string, string>> = {
  string: 'TEXT',
  'string[]': 'TEXT',
  'number[]': 'TEXT',
  json: 'TEXT',
  number: 'INTEGER',
  boolean: 'INTEGER',
  date: 'DATE',
}

/** Compare the SQL to the installed Better Auth schema, not to a second manually maintained column list. */
function checkTable(db: DatabaseSync, table: string, schema: ReturnType<typeof getSchema>[string]) {
  const columns = db.prepare('SELECT name, UPPER(type) AS type, "notnull", pk FROM pragma_table_info(?)').all(table)
  expect(columns, table).toEqual([
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    ...Object.entries(schema.fields).map(([name, field]) => ({
      name,
      type: field.bigint === true ? 'BIGINT' : typeof field.type === 'string' ? SQL_TYPES[field.type] : 'TEXT',
      notnull: field.required === false ? 0 : 1,
      pk: 0,
    })),
  ])
  const expectedIndexes = [
    { unique: true, columns: ['id'] },
    ...Object.entries(schema.fields).flatMap(([name, field]) => [
      ...(field.unique === true ? [{ unique: true, columns: [name] }] : []),
      ...(field.index === true ? [{ unique: false, columns: [name] }] : []),
    ]),
    ...(schema.indexes ?? []).map(({ unique, columns: indexColumns }) => ({
      unique: unique ?? false,
      columns: indexColumns,
    })),
  ]
  expect(indexes(db, table), table).toEqual(expect.arrayContaining(expectedIndexes))
  expect(indexes(db, table), table).toHaveLength(expectedIndexes.length)
  const references = Object.entries(schema.fields).flatMap(([name, field]) =>
    field.references === undefined
      ? []
      : [
          {
            from: name,
            table: field.references.model,
            to: field.references.field,
            on_delete: (field.references.onDelete ?? 'cascade').toUpperCase(),
          },
        ],
  )
  const actual = db.prepare('SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)').all(table)
  expect(actual, table).toEqual(expect.arrayContaining(references))
  expect(actual, table).toHaveLength(references.length)
}

/** A registered public client, exactly as an MCP client registers against the real provider. */
const registration = (auth: ReturnType<typeof createAuth>, changes: Record<string, unknown> = {}) =>
  auth.handler(
    new Request(`${APP}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP },
      body: JSON.stringify({
        client_name: 'baseline-fixture',
        redirect_uris: ['http://127.0.0.1:9/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...changes,
      }),
    }),
  )

describe('auth D1 baseline', () => {
  it('contains exactly the configured Better Auth schema, including columns, indexes and foreign keys', async () => {
    expect(migrations).toEqual(['0000_baseline.sql', '0001_api_keys.sql'])
    const { db, auth } = fixture()
    await auth.$context
    const schema = getSchema(auth.options)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row['name'])
    expect(tables).toEqual(Object.keys(schema).toSorted())
    for (const [table, fields] of Object.entries(schema)) checkTable(db, table, fields)
    expect(tables).toContain('rateLimit')
    expect(tables.some((name) => String(name).startsWith('app_'))).toBe(false)
  })

  it('enforces unique identities and client-resource pairs, and cascades deleted account authority', async () => {
    const { db, auth } = fixture()
    await auth.$context
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Owner', 'owner@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
        VALUES ('s1', '${NOW}', 'token-1', '${NOW}', '${NOW}', 'u1');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]');
      INSERT INTO oauthClientResource (id, clientId, resourceId) VALUES ('l1', 'client-1', '${APP}/mcp');
      INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt)
        VALUES ('consent-1', 'client-1', 'u1', '["goblin:inspect"]', '${NOW}', '${NOW}');
      INSERT INTO oauthRefreshToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes)
        VALUES ('refresh-1', 'refresh-token-1', 'client-1', 's1', 'u1', '${NOW}', '${NOW}', '["goblin:inspect"]');
      INSERT INTO oauthAccessToken (id, token, clientId, userId, refreshId, expiresAt, createdAt, scopes)
        VALUES ('access-1', 'access-token-1', 'client-1', 'u1', 'refresh-1', '${NOW}', '${NOW}', '["goblin:inspect"]');
      INSERT INTO rateLimit (id, key, count, lastRequest) VALUES ('limit-1', 'ip:1', 1, 100);
    `)
    expect(() =>
      db
        .prepare('INSERT INTO oauthClientResource (id, clientId, resourceId) VALUES (?, ?, ?)')
        .run('l2', 'client-1', `${APP}/mcp`),
    ).toThrow()
    expect(() =>
      db
        .prepare('INSERT INTO rateLimit (id, key, count, lastRequest) VALUES (?, ?, ?, ?)')
        .run('limit-2', 'ip:1', 2, 200),
    ).toThrow()
    expect(() =>
      db
        .prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s2', NOW, 'token-2', NOW, NOW, 'missing'),
    ).toThrow()
    db.exec("DELETE FROM session WHERE id = 's1'")
    expect(db.prepare('SELECT sessionId FROM oauthRefreshToken').get()).toEqual({ sessionId: null })
    db.exec("DELETE FROM user WHERE id = 'u1'")
    for (const table of ['oauthConsent', 'oauthRefreshToken', 'oauthAccessToken'])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 })
    db.exec("DELETE FROM oauthClient WHERE id = 'c1'")
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauthClientResource').get()).toEqual({ count: 0 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('registers current clients for one /mcp resource with inspection available and no pre-granted consent', async () => {
    const { db, auth } = fixture()
    const response = await registration(auth)
    expect(response.status, await response.clone().text()).toBe(201)
    const client = db.prepare('SELECT scopes, skipConsent FROM oauthClient').get()
    expect(JSON.parse(String(client?.['scopes']))).toEqual(SCOPES)
    expect(client?.['skipConsent']).not.toBe(1)
    expect(db.prepare('SELECT identifier, allowedScopes FROM oauthResource').all()).toEqual([
      { identifier: `${APP}/mcp`, allowedScopes: JSON.stringify(SCOPES) },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauthConsent').get()).toEqual({ count: 0 })
    const refused = await registration(auth, { scope: 'goblin:operator' })
    expect(refused.status, await refused.clone().text()).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauthClient').get()).toEqual({ count: 1 })
  })
})
