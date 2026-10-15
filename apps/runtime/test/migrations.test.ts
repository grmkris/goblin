import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../src/storage/migrations.ts'
import { assertApplicationTable } from '../src/storage/vendor.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { declaredTables } from './migration-schema.ts'

const databases: ReturnType<typeof chatDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})
const database = () => {
  const value = chatDatabase()
  databases.push(value)
  return value.sqlite
}

// SQLite creates these for the one application-owned virtual table; Drizzle has no FTS5 declaration.
const FTS = [
  'app_transcript_fts',
  'app_transcript_fts_config',
  'app_transcript_fts_data',
  'app_transcript_fts_docsize',
  'app_transcript_fts_idx',
]

describe('fresh application baseline', () => {
  it('creates exactly the live application tables and declares its complete ownership', async () => {
    const sqlite = database()
    const tables = await declaredTables()
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'app_*' ORDER BY name")
      .all()
      .map(({ name }) => name)
    expect(names).toEqual([...tables.keys(), ...FTS].toSorted())
    expect(MIGRATIONS.map(({ key }) => key)).toEqual(['20261015000000_baseline'])
    expect(MIGRATIONS[0].tables.toSorted()).toEqual([...tables.keys(), 'app_transcript_fts'].toSorted())
    for (const name of MIGRATIONS[0].tables) expect(() => assertApplicationTable(name)).not.toThrow()
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
