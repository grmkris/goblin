import { describe, expect, it } from '@effect/vitest'
import type { RoutineDefinition } from '@goblin/contracts'
import { PERSONAL_TOPIC } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { RoutineStore } from '../src/routines/store.ts'
import { routeRow } from '../src/sources/store.ts'
import { appMadeBy } from '../src/storage/made-by.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'
import { PAYLOAD_SETUP, message, sourceWorld } from './sources-fixture.ts'

const DM = '["dm",null]'

const DEFINITION: RoutineDefinition = {
  title: 'Daily',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  tellMe: { on: false, copy: false },
  handTo: {
    kind: 'goblin',
    instruction: 'Report.',
    allowedTools: [],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  },
}

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

describe('a room takes no routine and no Source (ADRs 0108, 0113)', () => {
  it('refuses a routine whose Topic a key made, and takes the same routine anywhere else', () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const sqlite = durable(db)
    const routines = new RoutineStore(sqlite, 'owner')
    expect(routines.propose(DEFINITION, 'op-open', 'rt_1', 1_000, PERSONAL_TOPIC).routine.state).toBe('proposed')
    sqlite.insert(appMadeBy).values({ keyId: 'key-1', kind: 'topic', resourceId: PERSONAL_TOPIC, createdAt: 1 }).run()
    expect(() => routines.propose(DEFINITION, 'op-room', 'rt_2', 2_000, PERSONAL_TOPIC)).toThrow(
      expect.objectContaining({ _tag: 'InvalidInput', reason: 'topic_room' }),
    )
  })

  it.effect("holds a Source's conversation whose setup names a room, and refuses routing one there", () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, active } = yield* sourceWorld()
      db.insert(appMadeBy).values({ keyId: 'key-1', kind: 'topic', resourceId: 4, createdAt: 1 }).run()
      const source = yield* active({ ...PAYLOAD_SETUP, newKeys: { to: 'topic', topic: 4 } })
      yield* engine.takeEvent(source, { eventId: 'e1', data: message('m1') }, ports)
      expect(seen.turns).toEqual([])
      expect(routeRow(db, source.row.id, DM)).toMatchObject({ route: 'held' })
      const refused = yield* Effect.flip(
        engine.route(source, { key: DM, target: { to: 'topic', topic: 4 }, by: 'owner' }, ports),
      )
      expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'topic_room' })
      expect(routeRow(db, source.row.id, DM)).toMatchObject({ route: 'held' })
    }),
  )
})
