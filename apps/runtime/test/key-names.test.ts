import { sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import type { KeyGrant } from '../src/http/api/principal.ts'
import { KeyNames } from '../src/keys/names.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'

const databases: ReturnType<typeof chatDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const key = (keyId: string, name: string): KeyGrant => ({ keyId, name, scopes: ['topics'], servers: [], origins: [] })

/** The key names over a fresh database, with what each topic of the change bus was told. */
const learning = () => {
  const database = chatDatabase()
  databases.push(database)
  const changes = makeChanges()
  const told: [string, readonly number[]][] = []
  Effect.runSync(
    Effect.all([
      changes.on('topics.changed', ({ ids }) => Effect.sync(() => void told.push(['topics', ids]))),
      changes.on('personas.changed', ({ ids }) => Effect.sync(() => void told.push(['personas', ids]))),
    ]),
  )
  const names = Effect.runSync(
    Effect.provide(
      KeyNames.use((service) => Effect.succeed(service)),
      KeyNames.layer.pipe(Layer.provide(Layer.merge(sqliteDb(database.db), Layer.succeed(Changes, changes)))),
    ),
  )
  return { db: database.db, names, told }
}

describe("a key's name (ADR 0108)", () => {
  it('names what the key made before names were kept on its first request, tells the views, and asks once', () => {
    const { db, names, told } = learning()
    db.run(
      sql`INSERT INTO app_key_reach (key_id, kind, resource_id, created_at) VALUES ('key-1', 'topic', 2, 1), ('key-1', 'topic', 3, 1), ('key-1', 'persona', 4, 1), ('key-2', 'topic', 5, 1)`,
    )
    Effect.runSync(names.learn(key('key-1', 'swarmm-prod')))
    expect(db.all(sql`SELECT key_id, resource_id, key_name FROM app_key_reach ORDER BY resource_id`)).toEqual([
      { key_id: 'key-1', resource_id: 2, key_name: 'swarmm-prod' },
      { key_id: 'key-1', resource_id: 3, key_name: 'swarmm-prod' },
      { key_id: 'key-1', resource_id: 4, key_name: 'swarmm-prod' },
      { key_id: 'key-2', resource_id: 5, key_name: null },
    ])
    expect(told).toEqual([
      ['topics', [2, 3]],
      ['personas', [4]],
    ])
    // The same key again in this lifetime asks nothing, even of a row named since.
    db.run(sql`UPDATE app_key_reach SET key_name = NULL WHERE resource_id = 2`)
    Effect.runSync(names.learn(key('key-1', 'swarmm-prod')))
    expect(db.all(sql`SELECT key_name FROM app_key_reach WHERE resource_id = 2`)).toEqual([{ key_name: null }])
    // A key with nothing unnamed tells nobody.
    Effect.runSync(names.learn(key('key-3', 'sidequest')))
    expect(told).toHaveLength(2)
  })
})
