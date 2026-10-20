import { ResidentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { ResidentLive } from '../../../src/layers/core.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events, Resident } from '../../../src/mcp/service.ts'
import { type Database, database, get, post, serve, served, sqliteDb, stub } from './fixture.ts'

/** Resident authority on SQLite (lane M's layer), counting the grants asked of it from outside. */
const countingResident = (db: Database, grants: number[]) =>
  Layer.effect(
    Resident,
    Effect.gen(function* () {
      const resident = yield* Resident
      return Resident.of({
        ...resident,
        grant: () =>
          Effect.andThen(
            Effect.sync(() => grants.push(1)),
            resident.grant(),
          ),
      })
    }),
  ).pipe(Layer.provide(ResidentLive.pipe(Layer.provide(sqliteDb(db)))))

describe('owner admission', () => {
  it('grants resident authority before an owner endpoint, but not before changing it (GrantsResident)', async () => {
    const grants: number[] = []
    const events = stub(Events, { disableServer: () => Effect.void })
    const { fetch } = serve(
      served([ResidentGroup], ResidentHandlers).pipe(
        Layer.provide(Layer.mergeAll(countingResident(database(), grants), events)),
      ),
    )
    expect((await fetch(get('/api/agent/resident'))).status).toBe(200)
    const renewed = grants.length
    expect(renewed).toBeGreaterThan(0)
    const revoked = await fetch(post('/api/agent/resident', { enabled: false }))
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ state: 'revoked' })
    expect(grants).toHaveLength(renewed)
  })
})
