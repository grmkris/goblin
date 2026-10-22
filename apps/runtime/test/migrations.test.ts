import { is } from 'drizzle-orm'
import { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../src/storage/migrations.ts'
import { assertApplicationTable } from '../src/storage/vendor.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { declaredTables } from './migration-schema.ts'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { BREAK } from '../src/storage/migrations/migration.ts'
import { residentStatus } from '../src/resident.ts'

const databases: ReturnType<typeof chatDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})
const database = () => {
  const value = chatDatabase()
  databases.push(value)
  return value.sqlite
}

const indexSnapshot = (sqlite: ReturnType<typeof database>, name: string) =>
  sqlite
    .prepare(`PRAGMA index_list("${name}")`)
    .all()
    .map((row) => ({
      columns: sqlite
        .prepare(`PRAGMA index_info("${String(row['name'])}")`)
        .all()
        .map((column) => column['name']),
      unique: Boolean(row['unique']),
      partial: Boolean(row['partial']),
    }))

// SQLite creates these for the one application-owned virtual table; Drizzle has no FTS5 declaration.
const FTS = [
  'app_transcript_fts',
  'app_transcript_fts_config',
  'app_transcript_fts_data',
  'app_transcript_fts_docsize',
  'app_transcript_fts_idx',
]

/** A database with the migrations before `key` applied, and a step that applies `key` and every one after it. */
const before = (key: string) => {
  const sqlite = new DatabaseSync(':memory:')
  const at = MIGRATIONS.findIndex((migration) => migration.key === key)
  const apply = (migrations: readonly (typeof MIGRATIONS)[number][]) => {
    for (const migration of migrations) for (const statement of migration.sql.split(BREAK)) sqlite.exec(statement)
  }
  apply(MIGRATIONS.slice(0, at))
  return { sqlite, rest: () => apply(MIGRATIONS.slice(at)) }
}

describe('resident authority until revoked (ADR 0088)', () => {
  it('keeps when it was granted and drops the expiry, so a lapsed one is active again', () => {
    const { sqlite, rest } = before('20261020200000_resident_until_revoked')
    // Authority as it was before: renewed at 100, lapsed at 200.
    sqlite.exec('INSERT INTO app_resident (id, renewed_at, expires_at, revoked_at) VALUES (1, 100, 200, NULL)')
    rest()
    expect(sqlite.prepare('SELECT * FROM app_resident').all()).toEqual([{ id: 1, granted_at: 100, revoked_at: null }])
    expect(residentStatus(drizzle({ client: sqlite }))).toEqual({ state: 'active', grantedAt: 100 })
    sqlite.close()
  })
})

describe('a Source keeps no proposer (ADR 0068)', () => {
  it('drops who proposed it and keeps the rest of the row', () => {
    const { sqlite, rest } = before('20261022000000_source_proposer')
    sqlite.exec(
      "INSERT INTO app_source_setups (id, operation_id, connection_id, title, setup, revision, state, proposed_by, chat_id, created_at, updated_at) VALUES ('src_00000000000000a1', 'op', 'feed', 'Feed', '{}', 2, 'active', 'owner', '1', 1, 2)",
    )
    rest()
    expect(
      sqlite.prepare('SELECT id, operation_id, title, revision, state, chat_id FROM app_source_setups').all(),
    ).toEqual([
      { id: 'src_00000000000000a1', operation_id: 'op', title: 'Feed', revision: 2, state: 'active', chat_id: '1' },
    ])
    const columns = sqlite.prepare('PRAGMA table_info("app_source_setups")').all()
    expect(columns.map((column) => column['name'])).not.toContain('proposed_by')
    sqlite.close()
  })
})

describe('a Persona thinks at its own level (ADR 0100)', () => {
  it('keeps every Persona and revision, which think at the default until they name a level', () => {
    const { sqlite, rest } = before('20261022120000_persona_thinking')
    sqlite.exec(
      "INSERT INTO app_personas (name, glyph, hue, role, instructions, revision, created_at, updated_at) VALUES ('Scout', 'S', 1, '', '', 1, 1, 1)",
    )
    sqlite.exec(
      "INSERT INTO app_persona_revisions (persona_id, revision, name, glyph, hue, role, instructions, actor, created_at) VALUES (1, 1, 'Scout', 'S', 1, '', '', 'owner', 1)",
    )
    rest()
    expect(sqlite.prepare('SELECT name, thinking FROM app_personas').all()).toEqual([{ name: 'Scout', thinking: null }])
    expect(sqlite.prepare('SELECT revision, thinking FROM app_persona_revisions').all()).toEqual([
      { revision: 1, thinking: null },
    ])
    expect(() => sqlite.exec("UPDATE app_personas SET thinking = 'max'")).toThrow(/CHECK/u)
    sqlite.close()
  })
})

describe('a receipt keeps who asked, by role (ADR 0099)', () => {
  it('keeps every receipt, which names no role until a member admits one', () => {
    const { sqlite, rest } = before('20261022160000_asker_role')
    sqlite.exec(
      "INSERT INTO app_chat_operations (chat_id, operation_id, session_id, admitted_at, kind, origin, state) VALUES ('1', 'op', '41', 1, 'send', 'owner', 'settled')",
    )
    rest()
    expect(sqlite.prepare('SELECT operation_id, kind, state, role FROM app_chat_operations').all()).toEqual([
      { operation_id: 'op', kind: 'send', state: 'settled', role: null },
    ])
    sqlite.exec("UPDATE app_chat_operations SET role = 'member'")
    expect(() => sqlite.exec("UPDATE app_chat_operations SET role = 'guest'")).toThrow(/CHECK/u)
    sqlite.close()
  })
})

describe('a room knows its key (ADR 0108)', () => {
  it('keeps what every key made, unnamed until the key makes something again, and finds it by resource', () => {
    const { sqlite, rest } = before('20261022180000_rooms')
    sqlite.exec("INSERT INTO app_key_reach (key_id, kind, resource_id, created_at) VALUES ('key-1', 'topic', 7, 1)")
    rest()
    expect(sqlite.prepare('SELECT key_id, kind, resource_id, key_name FROM app_key_reach').all()).toEqual([
      { key_id: 'key-1', kind: 'topic', resource_id: 7, key_name: null },
    ])
    const plan = sqlite
      .prepare("EXPLAIN QUERY PLAN SELECT key_id FROM app_key_reach WHERE kind = 'topic' AND resource_id = 7")
      .all()
    expect(plan.map((step) => String(step['detail'])).join('\n')).toContain('app_key_reach_resource')
    sqlite.close()
  })
})

describe('fresh application baseline', () => {
  it('creates exactly the live application tables and declares its complete ownership', async () => {
    const sqlite = database()
    const tables = await declaredTables()
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'app_*' ORDER BY name")
      .all()
      .map(({ name }) => name)
    expect(names).toEqual([...tables.keys(), ...FTS].toSorted())
    expect(MIGRATIONS.map(({ key }) => key)).toEqual([
      '20261015000000_baseline',
      '20261020000000_key_reach',
      '20261020120000_invocation_reason',
      '20261020200000_resident_until_revoked',
      '20261022000000_source_proposer',
      '20261022120000_persona_thinking',
      '20261022130000_persona_tools',
      '20261022150000_persona_tool_mode',
      '20261022160000_asker_role',
      '20261022170000_thread_servers',
      '20261022180000_rooms',
    ])
    // An additive migration that alters a table names it too, so a table may be named more than once.
    const owned = [...new Set(MIGRATIONS.flatMap((migration) => migration.tables))]
    expect(owned.toSorted()).toEqual([...tables.keys(), 'app_transcript_fts'].toSorted())
    for (const name of owned) expect(() => assertApplicationTable(name)).not.toThrow()
  })

  it('matches every live column, SQL type, nullability and default', async () => {
    const sqlite = database()
    for (const [name, table] of await declaredTables()) {
      const actual = sqlite
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((column) => ({
          name: column['name'],
          type: String(column['type']).toLowerCase(),
          notNull: Boolean(column['notnull'] || column['pk']),
          default: column['dflt_value'],
        }))
        .toSorted((a, b) => String(a.name).localeCompare(String(b.name)))
      const expected = table.columns
        .map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull || column.primary,
          default:
            column.default === undefined
              ? null
              : typeof column.default === 'string'
                ? `'${column.default.replaceAll("'", "''")}'`
                : String(Number(column.default)),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
      expect(actual, name).toEqual(expected)
    }
  })

  it('preserves declared primary keys and indexes, including uniqueness', async () => {
    const sqlite = database()
    for (const [name, table] of await declaredTables()) {
      const primary = sqlite
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .filter((column) => Number(column['pk']) > 0)
        .toSorted((a, b) => Number(a['pk']) - Number(b['pk']))
        .map((column) => column['name'])
      const declaredPrimary = table.primaryKeys.flatMap((key) => key.columns.map((column) => column.name))
      expect(primary, name).toEqual(
        declaredPrimary.length > 0
          ? declaredPrimary
          : table.columns.filter((column) => column.primary).map((column) => column.name),
      )
      const indexes = indexSnapshot(sqlite, name)
      const declared = table.indexes.map(({ config }) => ({
        columns: config.columns.map((column) => {
          expect(is(column, SQLiteColumn), `${name} index expression needs explicit verification`).toBe(true)
          return is(column, SQLiteColumn) ? column.name : undefined
        }),
        unique: config.unique,
        partial: config.where !== undefined,
      }))
      for (const column of table.columns.filter((each) => each.isUnique))
        declared.push({ columns: [column.name], unique: true, partial: false })
      for (const index of declared) expect(indexes, name).toContainEqual(index)
    }
  })

  it('keeps seeded defaults and partial uniqueness constraints', () => {
    const sqlite = database()
    expect(sqlite.prepare('SELECT id, name, chat_id, setup FROM app_topics').get()).toEqual({
      id: 1,
      name: 'Personal',
      chat_id: '1',
      setup: '{"mcpServers":"all","skills":"all","apps":"all","subagents":true}',
    })
    expect(sqlite.prepare('SELECT * FROM app_routine_settings').get()).toEqual({
      id: 1,
      timezone: 'UTC',
      max_active: 20,
      max_running: 2,
    })
    const topic = sqlite.prepare(
      "INSERT INTO app_topics (id, name, chat_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, 1)",
    )
    topic.run(2, 'Trips', '2')
    expect(() => topic.run(3, 'TRIPS', '3')).toThrow()
    sqlite.exec('UPDATE app_topics SET archived_at = 1 WHERE id = 2')
    expect(() => topic.run(3, 'TRIPS', '3')).not.toThrow()
    const move = sqlite.prepare(
      "INSERT INTO app_chat_moves (operation_id, chat_id, message_entry, state, created_at, updated_at) VALUES (?, '1', 1, ?, 1, 1)",
    )
    move.run('first', 'requested')
    expect(() => move.run('second', 'forked')).toThrow()
    sqlite.exec("UPDATE app_chat_moves SET state = 'settled' WHERE operation_id = 'first'")
    expect(() => move.run('second', 'forked')).not.toThrow()
    expect(() => move.run('retired', 'swapped')).toThrow()
  })

  it('maintains FTS5 on insert, update and delete', () => {
    const sqlite = database()
    const matches = (query: string) =>
      sqlite.prepare('SELECT rowid FROM app_transcript_fts WHERE app_transcript_fts MATCH ?').all(query)
    sqlite.exec(
      "INSERT INTO app_transcript_excerpts (entry_id, session_id, chat_id, role, at, text) VALUES (1, 'pi-session', '1', 'user', 1, 'orchard')",
    )
    expect(matches('orchard')).toEqual([{ rowid: 1 }])
    sqlite.exec("UPDATE app_transcript_excerpts SET text = 'harbor' WHERE entry_id = 1")
    expect(matches('orchard')).toEqual([])
    expect(matches('harbor')).toEqual([{ rowid: 1 }])
    sqlite.exec('DELETE FROM app_transcript_excerpts WHERE entry_id = 1')
    expect(matches('harbor')).toEqual([])
  })
})
