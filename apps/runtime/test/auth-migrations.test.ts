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
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'goblin:agent',
  'goblin:topics',
  'goblin:conversations',
  'goblin:personas',
  'goblin:inspect',
  'goblin:transcripts',
  'goblin:setup',
  'goblin:routines',
]
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

/**
 * Indexes goblin adds past Better Auth's schema, each for a reason of its own: one membership per person and workspace
 * (ADR 0089), which the plugin checks only by reading first.
 */
const OWN_INDEXES: Readonly<Record<string, readonly { unique: boolean; columns: readonly string[] }[]>> = {
  member: [{ unique: true, columns: ['organizationId', 'userId'] }],
}

/** goblin's own tables in the auth D1, beside Better Auth's: what each OAuth client's consent reaches (ADR 0097). */
const OWN_TABLES = ['mcpReach', 'mcpReachWorkspace'] as const

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
    ...(OWN_INDEXES[table] ?? []),
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
    expect(migrations).toEqual([
      '0000_baseline.sql',
      '0001_api_keys.sql',
      '0002_workspaces.sql',
      '0003_mcp_reach.sql',
      '0004_mcp_powers.sql',
    ])
    const { db, auth } = fixture()
    await auth.$context
    const schema = getSchema(auth.options)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row['name'])
    expect(tables).toEqual([...Object.keys(schema), ...OWN_TABLES].toSorted())
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

  it('gives every existing account a workspace with its own id, owned by it, with its keys and consents (ADR 0089)', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const workspaces = '0002_workspaces.sql'
    for (const name of migrations.slice(0, migrations.indexOf(workspaces)))
      db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('AbCd1234', 'Kris', 'kris.k+goblin@example.test', 1, '${NOW}', '${NOW}'),
               ('Zy98', '', 'swarmm_dev@example.test', 1, '${NOW}', '${NOW}'),
               ('Q1w2E3r4t5', '', 'odd!one@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt, metadata)
        VALUES ('k1', 'default', 'Zy98', 'hash', '${NOW}', '${NOW}', '{"servers":["mycut"]}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]');
      INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt)
        VALUES ('consent-1', 'client-1', 'AbCd1234', '[]', '${NOW}', '${NOW}');
    `)
    db.exec(readFileSync(join(DIR, workspaces), 'utf8'))
    expect(db.prepare('SELECT id, name, slug FROM organization ORDER BY id').all()).toEqual([
      { id: 'AbCd1234', name: "Kris's workspace", slug: 'kris-k-goblin-abcd' },
      { id: 'Q1w2E3r4t5', name: "odd!one's workspace", slug: 'ws-q1w2e3r4' },
      { id: 'Zy98', name: "swarmm_dev's workspace", slug: 'swarmm-dev-zy98' },
    ])
    expect(db.prepare('SELECT organizationId, userId, role FROM member ORDER BY userId').all()).toEqual([
      { organizationId: 'AbCd1234', userId: 'AbCd1234', role: 'owner' },
      { organizationId: 'Q1w2E3r4t5', userId: 'Q1w2E3r4t5', role: 'owner' },
      { organizationId: 'Zy98', userId: 'Zy98', role: 'owner' },
    ])
    expect(JSON.parse(String(db.prepare('SELECT metadata FROM apikey').get()?.['metadata']))).toEqual({
      servers: ['mycut'],
      createdBy: 'Zy98',
    })
    expect(db.prepare('SELECT referenceId FROM oauthConsent').get()).toEqual({ referenceId: 'AbCd1234' })
    expect(() =>
      db
        .prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run('m2', 'AbCd1234', 'AbCd1234', 'member', NOW),
    ).toThrow()
  })

  it("ends ADR 0089's workspace-named consents, keeps reaches to members' workspaces, and cascades them (ADR 0097)", () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const reach = '0003_mcp_reach.sql'
    for (const name of migrations.slice(0, migrations.indexOf(reach))) db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Kris', 'kris@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]');
      INSERT INTO oauthConsent (id, clientId, userId, referenceId, scopes, createdAt, updatedAt)
        VALUES ('consent-1', 'client-1', 'u1', 'w1', '[]', '${NOW}', '${NOW}');
      INSERT INTO oauthRefreshToken (id, token, clientId, userId, referenceId, expiresAt, createdAt, scopes)
        VALUES ('refresh-1', 'refresh-token-1', 'client-1', 'u1', 'w1', '${NOW}', '${NOW}', '[]');
    `)
    db.exec(readFileSync(join(DIR, reach), 'utf8'))
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauthConsent').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT revoked IS NOT NULL AS revoked FROM oauthRefreshToken').get()).toEqual({ revoked: 1 })
    db.exec(`
      INSERT INTO mcpReach (clientId, userId, "all", updatedAt) VALUES ('client-1', 'u1', 0, '${NOW}');
      INSERT INTO mcpReachWorkspace (clientId, userId, workspaceId) VALUES ('client-1', 'u1', 'w1');
    `)
    expect(() =>
      db.exec(`INSERT INTO mcpReachWorkspace (clientId, userId, workspaceId) VALUES ('client-1', 'u1', 'nowhere')`),
    ).toThrow()
    db.exec(`DELETE FROM organization WHERE id = 'w1'`)
    expect(db.prepare('SELECT COUNT(*) AS count FROM mcpReachWorkspace').get()).toEqual({ count: 0 })
    db.exec(`DELETE FROM oauthClient WHERE clientId = 'client-1'`)
    expect(db.prepare('SELECT COUNT(*) AS count FROM mcpReach').get()).toEqual({ count: 0 })
  })

  it('gives every client registered before the switches the whole scope list it may ask for (ADR 0098)', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const powers = '0004_mcp_powers.sql'
    for (const name of migrations.slice(0, migrations.indexOf(powers))) db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec(
      `INSERT INTO oauthClient (id, clientId, redirectUris, scopes) VALUES ('c1', 'client-1', '[]', '["openid"]')`,
    )
    db.exec(readFileSync(join(DIR, powers), 'utf8'))
    expect(JSON.parse(String(db.prepare('SELECT scopes FROM oauthClient').get()?.['scopes']))).toEqual(SCOPES)
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
