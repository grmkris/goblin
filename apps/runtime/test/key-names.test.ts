import { sql } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from '../src/http/api/principal.ts'
import { KeyNames } from '../src/keys/names.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'
import { credential } from './grants-fixture.ts'

const databases: ReturnType<typeof chatDatabase>[] = []
const scopes: Scope.Closeable[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) Effect.runSync(Scope.close(scope, Exit.void))
  for (const database of databases.splice(0)) database.close()
})

/** Lets the naming the request started beside it run (it never holds the request). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10))

const key = (keyId: string, name: string): Credential => credential({ id: keyId, name })

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
  // The layer's scope stays open for the test, as the agent's does for its lifetime: the naming runs in it.
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const layer = KeyNames.layer.pipe(Layer.provide(Layer.merge(sqliteDb(database.db), Layer.succeed(Changes, changes))))
  const names = Effect.runSync(
    Effect.map(Layer.buildWithScope(layer, scope), (context) => Context.get(context, KeyNames)),
  )
  return { db: database.db, names, told }
}

describe("a key's name, for display (ADR 0115)", () => {
  it('names what the key made before names were kept on its first request, tells the views, and asks once', async () => {
    const { db, names, told } = learning()
    db.run(
      sql`INSERT INTO app_made_by (key_id, kind, resource_id, created_at) VALUES ('key-1', 'topic', 2, 1), ('key-1', 'topic', 3, 1), ('key-1', 'persona', 4, 1), ('key-2', 'topic', 5, 1)`,
    )
    Effect.runSync(names.learn(key('key-1', 'swarmm-prod')))
    await settled()
    expect(db.all(sql`SELECT key_id, resource_id, key_name FROM app_made_by ORDER BY resource_id`)).toEqual([
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
    db.run(sql`UPDATE app_made_by SET key_name = NULL WHERE resource_id = 2`)
    Effect.runSync(names.learn(key('key-1', 'swarmm-prod')))
    await settled()
    expect(db.all(sql`SELECT key_name FROM app_made_by WHERE resource_id = 2`)).toEqual([{ key_name: null }])
    // A key with nothing unnamed tells nobody.
    Effect.runSync(names.learn(key('key-3', 'sidequest')))
    await settled()
    expect(told).toHaveLength(2)
  })
})
