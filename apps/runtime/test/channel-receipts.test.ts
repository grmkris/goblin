import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import { AppEngine } from '../src/agent-apps/service.ts'
import { telegramChannel } from '../src/channel/channel.ts'
import { routeRow, seeChat } from '../src/channel/routes.ts'
import { setChatRoute, setNewChatsDefault } from '../src/channel/routing.ts'
import { Channel } from '../src/channel/service.ts'
import { enableEvents, telegramRevision } from '../src/channel/store.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { ChatOperations, Chats, Conversations } from '../src/chats/service.ts'
import { McpConnections, McpGrants, McpServers, Resident } from '../src/mcp/service.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { undoReceipt } from '../src/organize/program.ts'
import { OrganizeReceipts } from '../src/organize/receipts.ts'
import { Receipts } from '../src/organize/service.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput } from '../src/runtime/input.ts'
import { RoutineControl, RoutineRuns } from '../src/routines/service.ts'
import { Setups } from '../src/setup/service.ts'
import { Skills } from '../src/skills/service.ts'
import { Sources } from '../src/sources/service.ts'
import { Topics } from '../src/topics/service.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'

const GROUP = 'g_trip0000000000000'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * Routes over real SQLite with the real channel and organizing receipts; Topic 4 ("Travel") and Persona 2 ("Guide")
 * are active, and nothing the routes reach beyond them is used (no message waits).
 */
const world = Effect.gen(function* () {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  const sqlite = durable(db)
  const channel = yield* telegramChannel({ db: sqlite, telemetry: undefined, wake: () => undefined })
  enableEvents(sqlite, 'mysi', 'c0', 1, { reach: 'all' })
  seeChat(sqlite, { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup' }, 1)
  const store = new OrganizeReceipts(sqlite, (kind, target) => telegramRevision(sqlite, kind, target))
  const topic = { id: 4, name: 'Travel', revision: 1 }
  const persona = { id: 2, name: 'Guide', revision: 1 }
  const services = Layer.mergeAll(
    Layer.succeed(Db, sqlite),
    Layer.succeed(Channel, channel),
    Layer.effect(Receipts, Receipts.make(store)).pipe(Layer.provide(Layer.succeed(Changes, makeChanges()))),
    // SAFETY: routes read only a Topic's id, name and archive mark, and a Persona's id and name.
    Layer.mock(Topics, { get: () => Effect.succeed(topic as never) }),
    // SAFETY: as above, for the Persona.
    Layer.mock(Personas, { active: Effect.succeed([persona as never]), get: () => Effect.succeed(persona as never) }),
    stub(Resident, { require: () => Effect.void }),
    stub(McpConnections),
    stub(McpServers),
    stub(McpGrants),
    stub(Chats),
    stub(ChatOperations),
    stub(Conversations),
    stub(PiSessions),
    stub(Invocations),
    stub(AgentInput),
    stub(Setups),
    // Only a Topic's Undo reaches the routines.
    stub(RoutineRuns),
    stub(RoutineControl),
    FlowEvents.noop,
    stub(Skills),
    stub(AppEngine),
    // Only a Source's route receipt reaches the Sources.
    stub(Sources),
  )
  return { db: sqlite, services, store }
})

describe('Telegram route receipts (unit)', () => {
  it.effect(
    "leaves a receipt for the agent's route change, and Undo puts the route back while nothing touched it",
    () =>
      Effect.gen(function* () {
        const { db, services, store } = yield* world
        const by = { actor: 'agent', chat: '1', operationId: 'organize:1:call-1' } as const
        const { summary } = yield* setChatRoute({ chat: GROUP, mode: 'answer', topic: 4, persona: 2 }, by).pipe(
          Effect.provide(services),
        )
        expect(summary).toBe('Telegram "Trip planning" is answered by @Guide in #Travel')
        const [receipt] = store.list()
        expect(receipt).toMatchObject({ kind: 'telegram.route', target: `${GROUP}:0`, actor: 'agent', undoable: true })
        yield* undoReceipt(receipt?.id ?? '').pipe(Effect.provide(services))
        expect(routeRow(db, GROUP, 0)).toMatchObject({ status: 'pending', mode: null, topicId: null })
        expect(store.list()[0]).toMatchObject({ undoable: false })
      }),
  )

  it.effect('refuses Undo once a later change touched the route, and undoes the new-chats default', () =>
    Effect.gen(function* () {
      const { services, store } = yield* world
      yield* setChatRoute({ chat: GROUP, mode: 'ignore' }, { actor: 'owner' }).pipe(Effect.provide(services))
      yield* setChatRoute({ chat: GROUP, mode: 'listen', topic: 4 }, { actor: 'owner' }).pipe(Effect.provide(services))
      const [later, first] = store.list()
      expect(later?.summary).toBe('Telegram "Trip planning" is kept as notes in #Travel')
      expect(first).toMatchObject({ undoable: false })
      const refused = yield* Effect.flip(undoReceipt(first?.id ?? '').pipe(Effect.provide(services)))
      expect(refused).toMatchObject({ _tag: 'Conflict', reason: 'touched' })
      expect(yield* setNewChatsDefault('topic', { actor: 'owner' }).pipe(Effect.provide(services))).toBe(
        'New Telegram chats each get a new Topic',
      )
      const [setting] = store.list()
      yield* undoReceipt(setting?.id ?? '').pipe(Effect.provide(services))
      expect(yield* Channel.use((channel) => channel.status).pipe(Effect.provide(services))).toMatchObject({
        newChats: 'ask',
      })
    }),
  )
})
