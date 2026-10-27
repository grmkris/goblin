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
/** Every scope a client could ask for under ADR 0098 (0004). */
const SCOPES_0004 = [
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
/** The scopes a client asks for since ADR 0114 (0005): the sign-in ones and `goblin`. */
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'goblin']
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

/**
 * goblin's own tables in the auth D1, beside Better Auth's: each credential's grant, its workspaces and its lists, and
 * the apps workspaces registered and installed (ADR 0118).
 */
const OWN_TABLES = ['app', 'grant', 'grantWorkspace', 'grantReach', 'installation'] as const

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

/** A row 0007 keeps: anything but the seeded key `k1`'s grant and what hangs off it. */
const notKey = (row: Record<string, unknown>) => row['id'] !== 'k1' && row['grantId'] !== 'k1'
describe('auth D1 baseline', () => {
  it('contains exactly the configured Better Auth schema, including columns, indexes and foreign keys', async () => {
    expect(migrations).toEqual([
      '0000_baseline.sql',
      '0001_api_keys.sql',
      '0002_workspaces.sql',
      '0003_mcp_reach.sql',
      '0004_mcp_powers.sql',
      '0005_grants.sql',
      '0006_apps.sql',
      '0007_no_keys.sql',
      '0008_no_key_extras.sql',
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
    expect(JSON.parse(String(db.prepare('SELECT scopes FROM oauthClient').get()?.['scopes']))).toEqual(SCOPES_0004)
  })

  it("keeps one grant per client and person and one per installation, and cascades the client's, person's and workspace's", () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    for (const name of migrations) db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Kris', 'kris@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]'), ('c2', 'app-1', '[]');
      INSERT INTO app (clientId, workspaceId, terms, script, createdBy, createdAt) VALUES ('app-1', 'w1', '{}', 1, 'u1', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, name, level, createdAt, updatedAt)
        VALUES ('in_1', 'app', 'app-1', 'swarmm', 'write', '${NOW}', '${NOW}');
      INSERT INTO installation (id, clientId, workspaceId, approvedBy, createdAt) VALUES ('in_1', 'app-1', 'w1', 'u1', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, workspacesAll, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u1', 'Claude Code', 'write', 1, '${NOW}', '${NOW}');
      INSERT INTO grantWorkspace (grantId, workspaceId, topics) VALUES ('in_1', 'w1', 'list'), ('cg_1', 'w1', 'list');
      INSERT INTO grantReach (grantId, workspaceId, kind, resourceId)
        VALUES ('in_1', 'w1', 'topic', '7'), ('cg_1', 'w1', 'topic', '1');
    `)
    expect(db.prepare('SELECT extras, lifetime, origins, expiresAt FROM "grant" WHERE id = ?').get('in_1')).toEqual({
      extras: '[]',
      lifetime: 'never',
      origins: '[]',
      expiresAt: null,
    })
    expect(
      db.prepare('SELECT personas, connections, generation FROM grantWorkspace WHERE grantId = ?').get('in_1'),
    ).toEqual({
      personas: 'all',
      connections: 'all',
      generation: 0,
    })
    const insert = (values: string) =>
      db.exec(`INSERT INTO "grant" (id, kind, clientId, userId, name, level, createdAt, updatedAt) VALUES ${values}`)
    // A second grant for the same client and person, a grant of either kind half made, and a key's, which is gone.
    for (const values of [
      `('cg_2', 'client', 'client-1', 'u1', 'again', 'read', '${NOW}', '${NOW}')`,
      `('cg_3', 'client', 'client-1', null, 'nobody', 'read', '${NOW}', '${NOW}')`,
      `('in_2', 'app', 'app-1', 'u1', 'a person', 'read', '${NOW}', '${NOW}')`,
      `('in_3', 'app', null, null, 'no client', 'read', '${NOW}', '${NOW}')`,
      `('k1', 'key', 'client-1', null, 'a key', 'read', '${NOW}', '${NOW}')`,
    ])
      expect(() => insert(values), values).toThrow()
    expect(() =>
      db.exec(
        `INSERT INTO grantReach (grantId, workspaceId, kind, resourceId) VALUES ('in_1', 'nowhere', 'topic', '1')`,
      ),
    ).toThrow()
    const count = (table: string) => db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.['count']
    db.exec(`DELETE FROM organization WHERE id = 'w1'`)
    expect([count('grant'), count('grantWorkspace'), count('grantReach'), count('installation')]).toEqual([2, 0, 0, 0])
    db.exec(`DELETE FROM user WHERE id = 'u1'`)
    expect(count('grant')).toBe(1)
    db.exec(`DELETE FROM oauthClient WHERE clientId = 'app-1'`)
    expect(count('grant')).toBe(0)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('drops every key and its grant, keeping every other grant and installation as it was (0007, ADR 0125)', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const noKeys = '0007_no_keys.sql'
    for (const name of migrations.slice(0, migrations.indexOf(noKeys))) db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Kris', 'kris@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}');
      INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt) VALUES ('k1', 'default', 'w1', 'h', '${NOW}', '${NOW}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]'), ('c2', 'app-1', '[]');
      INSERT INTO app (clientId, workspaceId, terms, script, createdBy, createdAt) VALUES ('app-1', 'w1', '{}', 0, 'u1', '${NOW}');
      INSERT INTO "grant" (id, kind, keyId, name, level, extras, lifetime, workspacesAll, origins, createdAt, updatedAt)
        VALUES ('k1', 'key', 'k1', 'svc', 'manage', '["setup"]', '365d', 0, '[]', '${NOW}', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, extras, origins, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u1', 'Claude', 'write', '["inspect"]', '[]', '${NOW}', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, name, level, origins, createdAt, updatedAt)
        VALUES ('in_1', 'app', 'app-1', 'Swarmm', 'manage', '[{"origin":"https://swarmm.app","tools":["plan"]}]', '${NOW}', '${NOW}');
      INSERT INTO grantWorkspace (grantId, workspaceId, topics, personas, connections, generation)
        VALUES ('k1', 'w1', 'all', 'all', 'list', 7), ('cg_1', 'w1', 'list', 'all', 'all', 3), ('in_1', 'w1', 'list', 'list', 'all', 5);
      INSERT INTO grantReach (grantId, workspaceId, kind, resourceId) VALUES ('k1', 'w1', 'connection', 'mysi'),
        ('cg_1', 'w1', 'topic', '1'), ('in_1', 'w1', 'topic', '4'), ('in_1', 'w1', 'persona', '2');
      INSERT INTO installation (id, clientId, workspaceId, approvedBy, createdAt) VALUES ('in_1', 'app-1', 'w1', 'u1', '${NOW}');
    `)
    const rows = (sql: string) => db.prepare(sql).all()
    const kept = () => ({
      grants: rows(
        'SELECT id, kind, clientId, userId, name, level, extras, lifetime, origins FROM "grant" ORDER BY id',
      ),
      workspaces: rows('SELECT * FROM grantWorkspace ORDER BY grantId'),
      listed: rows('SELECT * FROM grantReach ORDER BY grantId, kind'),
      installations: rows('SELECT * FROM installation'),
    })
    const before = kept()
    db.exec(readFileSync(join(DIR, noKeys), 'utf8'))
    expect(kept()).toEqual({
      grants: before.grants.filter(notKey),
      workspaces: before.workspaces.filter(notKey),
      listed: before.listed.filter(notKey),
      installations: before.installations,
    })
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row['name'])
    expect(tables).not.toContain('apikey')
    expect(tables.filter((name) => String(name).endsWith('_0007'))).toEqual([])
    expect(rows('PRAGMA table_info("grant")').map((column) => column['name'])).not.toContain('keyId')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('removes only the retired extra from client grants, installations and app terms (0008, ADR 0126)', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const migration = '0008_no_key_extras.sql'
    for (const name of migrations.slice(0, migrations.indexOf(migration)))
      db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Owner', 'owner@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]'), ('c2', 'app-1', '[]');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, extras, lifetime, expiresAt, origins, revokedAt, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u1', 'Client', 'manage', '["keys","inspect","setup"]', '30d', '${NOW}', '[]', '${NOW}', '${NOW}', '${NOW}'),
               ('in_1', 'app', 'app-1', null, 'App', 'read', '["keys"]', 'never', null, '[{"origin":"https://app.example.test/mcp","tools":["plan"]}]', null, '${NOW}', '${NOW}');
      INSERT INTO app (clientId, workspaceId, terms, script, createdBy, createdAt)
        VALUES ('app-1', 'w1', '{"level":"read","extras":["keys","routines"],"lifetime":"never","reach":{"workspaces":"list","each":[],"origins":[]}}', 1, 'u1', '${NOW}');
      INSERT INTO installation (id, clientId, workspaceId, approvedBy, createdAt)
        VALUES ('in_1', 'app-1', 'w1', 'u1', '${NOW}');
      INSERT INTO grantWorkspace (grantId, workspaceId, topics, personas, connections, generation)
        VALUES ('cg_1', 'w1', 'list', 'all', 'all', 3), ('in_1', 'w1', 'list', 'list', 'list', 5);
      INSERT INTO grantReach (grantId, workspaceId, kind, resourceId)
        VALUES ('cg_1', 'w1', 'topic', '1'), ('in_1', 'w1', 'persona', '2'), ('in_1', 'w1', 'connection', 'mycut');
    `)
    const rows = (table: string) => db.prepare(`SELECT * FROM "${table}"`).all()
    const before = rows('grant')
    const app = rows('app')[0]
    const related = ['installation', 'grantWorkspace', 'grantReach'].map(rows)
    const sql = readFileSync(join(DIR, migration), 'utf8')
    db.exec(sql)
    expect(rows('grant')).toEqual(
      before.map((row) => ({
        ...row,
        extras: row['id'] === 'cg_1' ? '["inspect","setup"]' : '[]',
      })),
    )
    expect(rows('app')).toEqual([
      {
        ...app,
        terms: JSON.stringify({ ...JSON.parse(String(app?.['terms'])), extras: ['routines'] }),
      },
    ])
    expect(['installation', 'grantWorkspace', 'grantReach'].map(rows)).toEqual(related)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const migrated = [rows('grant'), rows('app')]
    db.exec(sql)
    expect([rows('grant'), rows('app')]).toEqual(migrated)
    for (const unchanged of ['{broken', 'null', '[]', '["inspect"]']) {
      db.prepare('UPDATE "grant" SET extras = ?').run(unchanged)
      db.prepare('UPDATE app SET terms = ?').run(unchanged)
      db.exec(sql)
      expect(rows('grant').map((row) => row['extras'])).toEqual([unchanged, unchanged])
      expect(rows('app')[0]?.['terms']).toBe(unchanged)
    }
  })

  it("turns a seeded 0004 database's keys and consents into grants, row for row of the mapping (0005, ADR 0114)", () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const grants = '0005_grants.sql'
    for (const name of migrations.slice(0, migrations.indexOf(grants))) db.exec(readFileSync(join(DIR, name), 'utf8'))
    const key = (id: string, permissions: string | null, metadata: string | null, expiresAt: string | null) =>
      db
        .prepare(
          'INSERT INTO apikey (id, configId, name, referenceId, key, createdAt, updatedAt, permissions, metadata, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, 'default', `key ${id}`, 'w1', `hash-${id}`, NOW, NOW, permissions, metadata, expiresAt)
    const consent = (id: string, client: string, user: string, scopes: readonly string[]) =>
      db
        .prepare(
          'INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, client, user, JSON.stringify(scopes), NOW, NOW)
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Kris', 'kris@example.test', 1, '${NOW}', '${NOW}'), ('u2', 'Ana', 'ana@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}'), ('w2', 'Team', 'team', '${NOW}');
      INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES ('m1', 'w1', 'u1', 'owner', '${NOW}'), ('m2', 'w2', 'u1', 'member', '${NOW}'), ('m3', 'w2', 'u2', 'owner', '${NOW}');
      INSERT INTO oauthClient (id, clientId, name, redirectUris, scopes) VALUES
        ('c1', 'claude', 'Claude Code', '[]', '${JSON.stringify(SCOPES_0004)}'),
        ('c2', 'mysi', NULL, '[]', '${JSON.stringify(SCOPES_0004)}'),
        ('c3', 'probe', 'Probe', '[]', '${JSON.stringify(SCOPES_0004)}');
    `)
    // Keys: topics and personas manage, conversations write, inspect alone read; servers, origins and expiry.
    const origins = [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit'] }]
    key(
      'k-manage',
      '{"goblin":["topics","conversations","personas"]}',
      JSON.stringify({ servers: ['mycut', 'myplan'], origins, createdBy: 'u1' }),
      '2026-11-14T00:00:00.000Z',
    )
    key(
      'k-write',
      '{"goblin":["conversations","inspect"]}',
      '{"servers":[],"createdBy":"u1"}',
      '2026-10-22T00:00:00.000Z',
    )
    key('k-read', '{"goblin":["inspect"]}', '{"servers":["mycut"]}', '2027-10-15T00:00:00.000Z')
    key('k-none', null, null, null)
    key('k-odd', 'not json', '{"servers":"mycut"}', '2026-10-22T12:00:00.000Z')
    // Consents: every scope over all workspaces; asking alone over a listed one; reading and runs with no reach.
    consent('o1', 'claude', 'u1', [...SCOPES_0004])
    consent('o2', 'mysi', 'u1', ['openid', 'offline_access', 'goblin:agent'])
    consent('o3', 'probe', 'u2', ['openid', 'goblin:inspect', 'goblin:conversations'])
    consent('o4', 'probe', 'u1', ['openid', 'goblin:transcripts', 'goblin:routines'])
    db.exec(`
      INSERT INTO mcpReach (clientId, userId, "all", updatedAt) VALUES ('claude', 'u1', 1, '${NOW}'), ('mysi', 'u1', 0, '${NOW}'), ('probe', 'u1', 0, '${NOW}');
      INSERT INTO mcpReachWorkspace (clientId, userId, workspaceId) VALUES ('mysi', 'u1', 'w2'), ('probe', 'u1', 'w1');
      INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', '${NOW}', 't1', '${NOW}', '${NOW}', 'u1');
      INSERT INTO oauthRefreshToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes)
        VALUES ('r1', 'rt-1', 'claude', 's1', 'u1', '${NOW}', '${NOW}', '["openid","offline_access","goblin:agent","goblin:inspect"]');
      INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes)
        VALUES ('a1', 'at-1', 'claude', 'u1', '${NOW}', '${NOW}', '["openid"]');
      INSERT INTO oauthResource (id, identifier, name, allowedScopes) VALUES ('res', '${APP}/mcp', 'goblin', '${JSON.stringify(SCOPES_0004)}');
    `)
    db.exec(readFileSync(join(DIR, grants), 'utf8'))
    db.exec('PRAGMA foreign_keys = ON')
    const rows = (sql: string, ...values: string[]) => db.prepare(sql).all(...values)
    expect(
      rows(
        'SELECT id, kind, keyId, name, level, extras, lifetime, expiresAt, workspacesAll, origins, createdBy FROM "grant" WHERE kind = \'key\' ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'k-manage',
        kind: 'key',
        keyId: 'k-manage',
        name: 'key k-manage',
        level: 'manage',
        extras: '["setup"]',
        lifetime: '30d',
        expiresAt: '2026-11-14T00:00:00.000Z',
        workspacesAll: 0,
        origins: JSON.stringify(origins),
        createdBy: 'u1',
      },
      {
        id: 'k-none',
        kind: 'key',
        keyId: 'k-none',
        name: 'key k-none',
        level: 'read',
        extras: '[]',
        lifetime: 'never',
        expiresAt: null,
        workspacesAll: 0,
        origins: '[]',
        createdBy: null,
      },
      {
        id: 'k-odd',
        kind: 'key',
        keyId: 'k-odd',
        name: 'key k-odd',
        level: 'read',
        extras: '[]',
        lifetime: '30d',
        expiresAt: '2026-10-22T12:00:00.000Z',
        workspacesAll: 0,
        origins: '[]',
        createdBy: null,
      },
      {
        id: 'k-read',
        kind: 'key',
        keyId: 'k-read',
        name: 'key k-read',
        level: 'read',
        extras: '["inspect"]',
        lifetime: '365d',
        expiresAt: '2027-10-15T00:00:00.000Z',
        workspacesAll: 0,
        origins: '[]',
        createdBy: null,
      },
      {
        id: 'k-write',
        kind: 'key',
        keyId: 'k-write',
        name: 'key k-write',
        level: 'write',
        extras: '["inspect"]',
        lifetime: '7d',
        expiresAt: '2026-10-22T00:00:00.000Z',
        workspacesAll: 0,
        origins: '[]',
        createdBy: 'u1',
      },
    ])
    // Every key reaches every Topic and Persona of its workspace, and the connections it named.
    expect(
      rows(
        "SELECT grantId, workspaceId, topics, personas, connections FROM grantWorkspace WHERE grantId LIKE 'k-%' ORDER BY grantId",
      ),
    ).toEqual(
      ['k-manage', 'k-none', 'k-odd', 'k-read', 'k-write'].map((grantId) => ({
        grantId,
        workspaceId: 'w1',
        topics: 'all',
        personas: 'all',
        connections: 'list',
      })),
    )
    expect(
      rows("SELECT grantId, kind, resourceId FROM grantReach WHERE grantId LIKE 'k-%' ORDER BY grantId, resourceId"),
    ).toEqual([
      { grantId: 'k-manage', kind: 'connection', resourceId: 'mycut' },
      { grantId: 'k-manage', kind: 'connection', resourceId: 'myplan' },
      { grantId: 'k-read', kind: 'connection', resourceId: 'mycut' },
    ])
    // The key keeps its secret and who made it; what it may do is its grant's alone.
    expect(rows('SELECT id, permissions, metadata, expiresAt FROM apikey ORDER BY id')).toEqual([
      { id: 'k-manage', permissions: null, metadata: '{"createdBy":"u1"}', expiresAt: null },
      { id: 'k-none', permissions: null, metadata: null, expiresAt: null },
      { id: 'k-odd', permissions: null, metadata: null, expiresAt: null },
      { id: 'k-read', permissions: null, metadata: null, expiresAt: null },
      { id: 'k-write', permissions: null, metadata: '{"createdBy":"u1"}', expiresAt: null },
    ])
    const clients = rows(
      'SELECT id, clientId, userId, name, level, extras, lifetime, workspacesAll, createdBy FROM "grant" WHERE kind = \'client\' ORDER BY clientId, userId',
    )
    expect(clients).toEqual([
      {
        id: expect.stringMatching(/^cg_[0-9a-f]{32}$/u),
        clientId: 'claude',
        userId: 'u1',
        name: 'Claude Code',
        level: 'manage',
        extras: '["setup","routines","inspect"]',
        lifetime: 'never',
        workspacesAll: 1,
        createdBy: 'u1',
      },
      {
        id: expect.stringMatching(/^cg_/u),
        clientId: 'mysi',
        userId: 'u1',
        name: 'MCP client',
        level: 'write',
        extras: '[]',
        lifetime: 'never',
        workspacesAll: 0,
        createdBy: 'u1',
      },
      {
        id: expect.stringMatching(/^cg_/u),
        clientId: 'probe',
        userId: 'u1',
        name: 'Probe',
        level: 'read',
        extras: '["routines","inspect"]',
        lifetime: 'never',
        workspacesAll: 0,
        createdBy: 'u1',
      },
      {
        id: expect.stringMatching(/^cg_/u),
        clientId: 'probe',
        userId: 'u2',
        name: 'Probe',
        level: 'write',
        extras: '["inspect"]',
        lifetime: 'never',
        workspacesAll: 0,
        createdBy: 'u2',
      },
    ])
    const idOf = (client: string, user: string) =>
      String(rows('SELECT id FROM "grant" WHERE clientId = ? AND userId = ?', client, user)[0]?.['id'])
    const reachOf = (grantId: string) => ({
      workspaces: rows(
        'SELECT workspaceId, topics, personas, connections FROM grantWorkspace WHERE grantId = ? ORDER BY workspaceId',
        grantId,
      ),
      listed: rows(
        'SELECT workspaceId, kind, resourceId FROM grantReach WHERE grantId = ? ORDER BY workspaceId',
        grantId,
      ),
    })
    // All of its person's workspaces: no row, everything in each.
    expect(reachOf(idOf('claude', 'u1'))).toEqual({ workspaces: [], listed: [] })
    // Asking the agent alone reaches Personal of each workspace it reached, and nothing else of Topics or Personas.
    expect(reachOf(idOf('mysi', 'u1'))).toEqual({
      workspaces: [{ workspaceId: 'w2', topics: 'list', personas: 'list', connections: 'all' }],
      listed: [{ workspaceId: 'w2', kind: 'topic', resourceId: '1' }],
    })
    // A listed reach is its workspaces in full; no reach at all is no workspace, as before.
    expect(reachOf(idOf('probe', 'u1'))).toEqual({
      workspaces: [{ workspaceId: 'w1', topics: 'all', personas: 'all', connections: 'all' }],
      listed: [],
    })
    expect(reachOf(idOf('probe', 'u2'))).toEqual({ workspaces: [], listed: [] })
    // One scope, `goblin`, from now on, for every consent, token, client and the resource.
    const scopes = (table: string) =>
      rows(`SELECT scopes FROM ${table} ORDER BY id`).map((row) => JSON.parse(String(row['scopes'])))
    expect(scopes('oauthConsent')).toEqual([
      ['openid', 'profile', 'email', 'offline_access', 'goblin'],
      ['openid', 'offline_access', 'goblin'],
      ['openid', 'goblin'],
      ['openid', 'goblin'],
    ])
    expect(scopes('oauthRefreshToken')).toEqual([['openid', 'offline_access', 'goblin']])
    expect(scopes('oauthAccessToken')).toEqual([['openid']])
    expect(scopes('oauthClient')).toEqual([SCOPES, SCOPES, SCOPES])
    expect(rows('SELECT allowedScopes FROM oauthResource')).toEqual([{ allowedScopes: JSON.stringify(SCOPES) }])
    expect(
      rows("SELECT name FROM sqlite_master WHERE name IN ('mcpReach', 'mcpReachWorkspace', 'grantConsent')"),
    ).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rebuilds the grant tables keeping every grant, and takes apps and their installations, which cascade (ADR 0118)', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const apps = '0006_apps.sql'
    for (const name of migrations.slice(0, migrations.indexOf(apps))) db.exec(readFileSync(join(DIR, name), 'utf8'))
    db.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Kris', 'kris@example.test', 1, '${NOW}', '${NOW}');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Mine', 'mine', '${NOW}');
      INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt) VALUES ('k1', 'default', 'w1', 'h', '${NOW}', '${NOW}');
      INSERT INTO oauthClient (id, clientId, redirectUris) VALUES ('c1', 'client-1', '[]'), ('c2', 'client-2', '[]');
      INSERT INTO "grant" (id, kind, keyId, name, level, extras, lifetime, workspacesAll, origins, createdAt, updatedAt)
        VALUES ('k1', 'key', 'k1', 'svc', 'manage', '["setup"]', '365d', 0, '[]', '${NOW}', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, userId, name, level, createdAt, updatedAt)
        VALUES ('cg_1', 'client', 'client-1', 'u1', 'Claude', 'write', '${NOW}', '${NOW}');
      INSERT INTO grantWorkspace (grantId, workspaceId, topics, personas, connections, generation)
        VALUES ('k1', 'w1', 'all', 'all', 'list', 7), ('cg_1', 'w1', 'list', 'all', 'all', 3);
      INSERT INTO grantReach (grantId, workspaceId, kind, resourceId) VALUES ('k1', 'w1', 'connection', 'mysi'),
        ('cg_1', 'w1', 'topic', '1');
    `)
    const rows = (sql: string) => db.prepare(sql).all()
    const before = {
      grants: rows('SELECT * FROM "grant" ORDER BY id'),
      workspaces: rows('SELECT * FROM grantWorkspace ORDER BY grantId'),
      listed: rows('SELECT * FROM grantReach ORDER BY grantId'),
    }
    db.exec(readFileSync(join(DIR, apps), 'utf8'))
    expect({
      grants: rows('SELECT * FROM "grant" ORDER BY id'),
      workspaces: rows('SELECT * FROM grantWorkspace ORDER BY grantId'),
      listed: rows('SELECT * FROM grantReach ORDER BY grantId'),
    }).toEqual(before)
    // An app's grant names its client and no person; any other shape is refused.
    db.exec(`
      INSERT INTO app (clientId, workspaceId, terms, script, createdBy, createdAt) VALUES ('client-2', 'w1', '{}', 0, 'u1', '${NOW}');
      INSERT INTO "grant" (id, kind, clientId, name, level, createdAt, updatedAt)
        VALUES ('in_1', 'app', 'client-2', 'Swarmm', 'write', '${NOW}', '${NOW}');
      INSERT INTO grantWorkspace (grantId, workspaceId) VALUES ('in_1', 'w1');
      INSERT INTO installation (id, clientId, workspaceId, approvedBy, createdAt) VALUES ('in_1', 'client-2', 'w1', 'u1', '${NOW}');
    `)
    const insertGrant = db.prepare(
      'INSERT INTO "grant" (id, kind, keyId, clientId, userId, name, level, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    expect(() => insertGrant.run('in_2', 'app', null, 'client-2', 'u1', 'x', 'read', NOW, NOW)).toThrow()
    expect(() => insertGrant.run('in_3', 'app', 'k1', 'client-2', null, 'x', 'read', NOW, NOW)).toThrow()
    expect(() =>
      db
        .prepare('INSERT INTO installation (id, clientId, workspaceId, createdAt) VALUES (?, ?, ?, ?)')
        .run('k1', 'client-2', 'w1', NOW),
    ).toThrow()
    // The person who approved it may go; the installation stays. The client going takes the app and all of it.
    db.exec("DELETE FROM user WHERE id = 'u1'")
    expect(rows('SELECT id, approvedBy FROM installation')).toEqual([{ id: 'in_1', approvedBy: 'u1' }])
    db.exec("DELETE FROM oauthClient WHERE clientId = 'client-2'")
    for (const table of ['app', 'installation'])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 })
    expect(rows('SELECT id FROM "grant" ORDER BY id')).toEqual([{ id: 'k1' }])
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
