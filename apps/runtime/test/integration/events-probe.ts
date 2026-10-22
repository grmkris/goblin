import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { RunTelemetry } from '../../src/telemetry/events.ts'
import { mcpReporter } from '../../src/telemetry/report.ts'
import { CredentialCipher } from '../../src/mcp/oauth/cipher.ts'
import { GrantDenied } from '../../src/http/errors.ts'
import { type EventsOptions, makeEvents } from '../../src/mcp/events/engine.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { makeManager } from '../../src/mcp/connections/manager.ts'
import { offersEvents } from '../../src/mcp/connections/remote.ts'
import { McpConnections } from '../../src/mcp/service.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appEventDeliveries } from '../../src/storage/schema.ts'
import { EventsFixture } from '../mcp/events-fixture.ts'
import { CollectedRuns } from '../telemetry-sink.ts'
import type { EventEnvelope } from '../../src/mcp/events/protocol.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { eventsSkillsProbe, eventsRecoveryProbe } from './events-recovery.ts'
import { eventsRaceProbe } from './events-races.ts'
import { servicesOf } from '../mcp/runtime.ts'
import { type Probes, inAgent } from './probe.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const occurrence = (fixture: EventsFixture, eventId: string): EventEnvelope => ({
  eventId,
  name: 'post.created',
  timestamp: new Date(fixture.now).toISOString(),
  data: { inboxCursor: fixture.cursor },
  cursor: fixture.cursor,
})

async function setup(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const store = new SqliteEventStore(db)
  const skillState = new SqliteSkillState(db)
  const cipher = await CredentialCipher.fromBase64(KEY)
  const fixture = new EventsFixture()
  const runs = new CollectedRuns()
  const telemetry = new RunTelemetry([runs])
  const wakes: number[] = []
  // The probe's services: the connections over the fixture, on a test clock the probe moves with the fixture's.
  const services = servicesOf(
    Layer.effect(
      McpConnections,
      Effect.orDie(
        makeManager({
          servers: [{ connectionId: 'feed', endpoint: 'https://events.test/mcp' }],
          allows: () => true,
          skillsEnabled: (connectionId) => skillState.enabled(connectionId),
          auth: () => ({ token: async () => 'synthetic-fixture-bearer' }),
          fetch: (input, init) => fixture.fetch(input, init),
          report: mcpReporter(telemetry),
        }),
      ),
    ).pipe(Layer.provideMerge(Layer.mergeAll(SingleFlight.layer, TestClock.layer()))),
  )
  const { run } = services
  await run(TestClock.setTime(fixture.now))
  const connections = await run(McpConnections)
  const eventOptions: EventsOptions = {
    connections,
    store,
    cipher,
    principal: 'fixture-owner',
    callback: () => Effect.succeed('https://goblin.test/hooks/mcp-events/owner/fixture/token'),
    authority: Effect.void,
    connected: () => Effect.void,
    authorize: (connectionId, name, args) =>
      store.allows(connectionId, name, args) ? Effect.void : Effect.fail(new GrantDenied({ connectionId, name })),
    wake: (at) =>
      Effect.sync(() => {
        wakes.push(at)
      }),
  }
  const events = await run(makeEvents(eventOptions))
  fixture.receiver = async (request) => {
    const exit = await run(
      Effect.exit(
        events.receive({
          connectionId: 'feed',
          body: new Uint8Array(await request.arrayBuffer()),
          id: request.headers.get('webhook-id') ?? '',
          timestamp: request.headers.get('webhook-timestamp') ?? '',
          signature: request.headers.get('webhook-signature') ?? '',
          subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
        }),
      ),
    )
    if (Exit.isFailure(exit)) return new Response(null, { status: 400 })
    return new Response(exit.value.response ?? null, { status: exit.value.status })
  }
  const delivered: string[] = []
  await run(
    events.register('fixture-message', ({ consumer, envelope }) =>
      Effect.sync(() => {
        if ('eventId' in envelope) delivered.push(`${consumer.consumerId}:${envelope.eventId}`)
      }),
    ),
  )
  return {
    db,
    runs,
    store,
    cipher,
    fixture,
    connections,
    events,
    eventOptions,
    skillState,
    run,
    dispose: services.dispose,
    /** Moves the fixture's clock and the agent's together. */
    clock: async (at: number) => {
      fixture.now = at
      await run(TestClock.setTime(at))
    },
    wakes,
    delivered,
  }
}

export type EventsProbeState = Awaited<ReturnType<typeof setup>>

async function subscribeMessages(state: Awaited<ReturnType<typeof setup>>) {
  for (const name of ['post.created', 'post.liked']) {
    state.store.grant('feed', name, '{}', true, state.fixture.now)
    await state.run(
      state.events.subscribe({
        consumerId: `fixture:${name}`,
        revision: 1,
        connectionId: 'feed',
        name,
        arguments: {},
        handlerKey: 'fixture-message',
      }),
    )
  }
  await state.run(
    state.events.subscribe({
      consumerId: 'second-consumer',
      revision: 1,
      connectionId: 'feed',
      name: 'post.created',
      arguments: {},
      handlerKey: 'fixture-message',
    }),
  )
}

async function exercise(state: Awaited<ReturnType<typeof setup>>) {
  const { fixture, events, store, delivered, run } = state
  const first = fixture.now
  fixture.cursor = '1'
  const envelope = occurrence(fixture, 'evt_1')
  const received = await fixture.deliver('sub_post.created', envelope, 'evt_1')
  await run(events.dispatch())
  const replayed = await fixture.deliver('sub_post.created', envelope, 'evt_1')
  await run(events.dispatch())
  const bad = await fixture.deliver('sub_post.created', occurrence(fixture, 'evt_bad'), 'evt_bad', {
    signature: 'v1,invalid',
  })
  const old = await fixture.deliver('sub_post.created', occurrence(fixture, 'evt_old'), 'evt_old', {
    timestamp: String(Math.floor(first / 1000) - 301),
  })
  fixture.cursor = '2'
  fixture.journal.push({
    eventId: 'evt_2',
    name: 'post.created',
    timestamp: new Date(first).toISOString(),
    data: { inboxCursor: '2' },
    cursor: '2',
  })
  await fixture.deliver('sub_post.created', { type: 'gap', cursor: '1' }, 'msg_gap_fixture')
  await run(events.maintain())
  const beforeRefresh = fixture.calls.filter((m) => m === 'events/subscribe').length
  await state.clock(first + 3_600_000 - 299_000)
  await run(events.maintain())
  const refreshedEarly = fixture.calls.filter((m) => m === 'events/subscribe').length > beforeRefresh
  await fixture.deliver('sub_post.created', { type: 'terminated', error: { code: -32012 } }, 'msg_terminated_fixture')
  await run(events.maintain())
  const terminated = store.selector('feed', 'post.created', '{}')?.status
  const cleanup = await run(events.unsubscribe({ consumerId: 'fixture:post.created', revision: 1 }))
  const sharedPreserved = fixture.subscriptions.has('sub_post.created')
  await run(events.unsubscribe({ consumerId: 'second-consumer', revision: 1 }))
  await run(events.unsubscribe({ consumerId: 'fixture:post.liked', revision: 1 }))
  return {
    received: received.status,
    replayed: replayed.status,
    bad: bad.status,
    old: old.status,
    delivered: delivered.toSorted(),
    refreshedEarly,
    terminated,
    cleanup,
    remainingRemote: fixture.subscriptions.size,
    sharedPreserved,
    pollRecovered: fixture.calls.includes('events/poll'),
    challengeReceipts: state.db
      .select()
      .from(appEventDeliveries)
      .all()
      .filter((r) => r.kind === 'verification').length,
  }
}

/** Real workerd SQLite + official MCP transport. No model/provider/network traffic. */
async function eventsProbe(storage: DurableObjectStorage) {
  const state = await setup(storage)
  try {
    await subscribeMessages(state)
    const discovered = offersEvents(await state.run(state.connections.connect('feed')))
    const result = await exercise(state)
    const skills = await eventsSkillsProbe(state)
    const recovery = await eventsRecoveryProbe(state)
    const races = await eventsRaceProbe(state)
    return {
      ...result,
      discovered,
      skills,
      recovery,
      races,
      scheduledRecovery: state.wakes.length > 0,
    }
  } finally {
    await state.dispose()
  }
}

export const probes: Probes = { events: inAgent(({ storage }) => eventsProbe(storage)) }
