import { describe, expect, it } from '@effect/vitest'
import type { RoutineDefinition } from '@goblin/contracts'
import { PERSONAL_TOPIC } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach } from 'vitest'
import { ChatId } from '../src/chats/directory.ts'
import { Chats } from '../src/chats/service.ts'
import { Forbidden } from '../src/http/errors.ts'
import { BOUNDARY_TEXT, adminOnly } from '../src/pi/asker.ts'
import { BACKGROUND, conversationId } from '../src/pi/context.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { callBoundary, requireWithin, sessionBoundary } from '../src/pi/within.ts'
import { RoutineStore } from '../src/routines/store.ts'
import { routeRow } from '../src/sources/store.ts'
import { appMadeBy } from '../src/storage/made-by.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'
import { fake } from './fake.ts'
import { stub } from './http/api/fixture.ts'
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

describe('a Topic a key made takes routines and Sources like any other (ADR 0115)', () => {
  it('takes a routine whose Topic a key made: tenancy is the sender’s, not the place’s', () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    const sqlite = durable(db)
    const routines = new RoutineStore(sqlite, 'owner')
    sqlite.insert(appMadeBy).values({ keyId: 'key-1', kind: 'topic', resourceId: PERSONAL_TOPIC, createdAt: 1 }).run()
    expect(routines.propose(DEFINITION, 'op-made', 'rt_1', 1_000, PERSONAL_TOPIC).routine.state).toBe('proposed')
  })

  it.effect("routes a Source's conversation into a Topic a key made", () =>
    Effect.gen(function* () {
      const { db, engine, ports, active } = yield* sourceWorld()
      db.insert(appMadeBy).values({ keyId: 'key-1', kind: 'topic', resourceId: 4, createdAt: 1 }).run()
      const source = yield* active(PAYLOAD_SETUP)
      yield* engine.takeEvent(source, { eventId: 'e1', data: message('m1') }, ports)
      yield* engine.route(source, { key: DM, target: { to: 'topic', topic: 4 }, by: 'owner' }, ports)
      expect(routeRow(db, source.row.id, DM)).toMatchObject({ route: 'topic', topicId: 4 })
    }),
  )
})

/** Personal (1, the hub), Customer A (2) and Customer B (3), each with its Conversation; Chats knows each by its id. */
const places = () => {
  const { db, sqlite, close } = chatDatabase()
  sqlite.exec(`INSERT INTO app_topics (id, name, chat_id, created_by, created_at, updated_at) VALUES
    (2, 'A', '20', 'owner', 1, 1), (3, 'B', '30', 'owner', 1, 1)`)
  sqlite.exec(`INSERT INTO app_conversations (session_id, pi_session, role, kind, created_at, topic_id) VALUES
    ('1', '1', 'primary', 'main', 1, 1), ('20', '20', 'conversation', 'main', 1, 2),
    ('30', '30', 'conversation', 'main', 1, 3)`)
  const known = new Set(['1', '20', '30'])
  return Layer.mergeAll(
    sqliteDb(db),
    stub(Chats, {
      chatOf: (session: string) => Effect.succeed(known.has(session) ? Option.some(ChatId(session)) : Option.none()),
    }),
    // A call outside a live run is the agent's own work, which reads no submission.
    Layer.succeed(PiSessions, fake<PiSessions['Service']>({})),
    Layer.succeed(AgentInput, fake<AgentInputs>({})),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close))),
  )
}

/** A call in session `session` outside a live run: the agent's own work, an admin's. */
const call = (session: string) => ({
  conversationId: conversationId(session),
  snapshot: async () => undefined,
})

describe("what the agent's tools act on from where they run (ADR 0115)", () => {
  it.effect('acts on its own Topic from a sealed one, and on any Topic from the hub', () =>
    Effect.gen(function* () {
      expect(yield* sessionBoundary('20')).toEqual({ topic: 2, hub: false })
      expect(yield* callBoundary(call('1'), BACKGROUND)).toEqual({ topic: 1, hub: true })
      yield* requireWithin(call('20'), BACKGROUND, 2)
      const refused = yield* Effect.flip(requireWithin(call('20'), BACKGROUND, 3))
      expect(refused).toMatchObject({ _tag: 'Forbidden', reason: 'boundary' })
      yield* requireWithin(call('1'), BACKGROUND, 3)
      // A session no chat owns reaches nothing.
      expect(yield* sessionBoundary('99')).toBeUndefined()
      expect(yield* Effect.flip(requireWithin(call('99'), BACKGROUND, 2))).toMatchObject({ reason: 'boundary' })
    }).pipe(Effect.provide(places())),
  )

  it('tells the model why, and where the change can be made', () => {
    expect(adminOnly('Topics')(new Forbidden({ reason: 'boundary' }))).toBe(BOUNDARY_TEXT)
    expect(BOUNDARY_TEXT).toContain('from a hub')
  })
})
