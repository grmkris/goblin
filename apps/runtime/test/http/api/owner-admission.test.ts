import { ResidentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { ResidentLive } from '../../../src/layers/core.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { Events, Resident } from '../../../src/mcp/service.ts'
import { type Database, database, get, post, serve, served, sqliteDb, stub } from './fixture.ts'
import { credential, credentialHeaders } from '../../grants-fixture.ts'

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

/** A request's member header, for Ana with `role`, and `extra` headers. */
const as = (role: string, extra: Record<string, string> = {}) => ({
  'x-goblin-member': JSON.stringify({ user: 'ana', role, name: 'Ana', shared: false }),
  ...extra,
})

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

  // A forward that says no one, or says it in a header that does not decode, is refused, never taken for the owner
  // (ADR 0089); `serve` sends the owner's member header only when a request names neither a caller nor a member.
  it.each([
    ['a malformed member', { 'x-goblin-member': '{"user":"owner","role":"king"}' }],
    [
      'a malformed caller beside a member',
      { 'x-goblin-member': '{"user":"owner","role":"owner","name":"Owner","shared":false}', 'x-goblin-caller': '{' },
    ],
    ['a member that is not JSON', { 'x-goblin-member': 'owner' }],
  ] as const)('refuses %s without granting resident authority', async (_case, headers) => {
    const grants: number[] = []
    const events = stub(Events, { disableServer: () => Effect.void })
    const { fetch } = serve(
      served([ResidentGroup], ResidentHandlers).pipe(
        Layer.provide(Layer.mergeAll(countingResident(database(), grants), events)),
      ),
    )
    const refused = await fetch(new Request('https://agent/api/agent/resident', { headers }))
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { code: 'unauthenticated', reason: 'principal' } })
    expect(grants).toHaveLength(0)
  })

  it("refuses a member below an endpoint's role, and an OAuth client acting for one (ADR 0093)", async () => {
    const grants: number[] = []
    const events = stub(Events, { disableServer: () => Effect.void })
    const { fetch } = serve(
      served([ResidentGroup], ResidentHandlers).pipe(
        Layer.provide(Layer.mergeAll(countingResident(database(), grants), events)),
      ),
    )
    // Reading resident authority is any member's; changing it is an owner's or an admin's.
    expect((await fetch(get('/api/agent/resident', as('member')))).status).toBe(200)
    const refused = await fetch(post('/api/agent/resident', { enabled: false }, as('member')))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
    expect((await fetch(post('/api/agent/resident', { enabled: false }, as('admin')))).status).toBe(200)
    // A credential reaches no endpoint without `EndpointAccess`, whatever its grant or its person's role.
    const client = as(
      'admin',
      credentialHeaders(credential({ kind: 'client', id: 'c', grantId: 'cg_1', level: 'manage' })),
    )
    const refusedClient = await fetch(post('/api/agent/resident', { enabled: true }, client))
    expect(refusedClient.status).toBe(403)
    expect(await refusedClient.json()).toMatchObject({ error: { code: 'forbidden', reason: 'credential' } })
  })
})
