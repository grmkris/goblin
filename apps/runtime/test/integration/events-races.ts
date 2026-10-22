import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Predicate from 'effect/Predicate'
import { UpstreamMcp } from '../../src/http/errors.ts'
import { makeEvents } from '../../src/mcp/events/engine.ts'
import type { EventsOptions } from '../../src/mcp/events/engine.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import type { EventsProbeState } from './events-probe.ts'

/** Pause one actual connection request; the Events engine, SQLite store and official producer stay real. */
async function delayed(state: EventsProbeState, method: 'events/list' | 'events/unsubscribe') {
  const entered = await state.run(Deferred.make<void>())
  const release = await state.run(Deferred.make<void>())
  let waited = false
  const connections: EventsOptions['connections'] = {
    server: state.connections.server,
    events: (connectionId, requested, params, schema, authorize) =>
      Effect.gen(function* () {
        if (requested === method && !waited) {
          waited = true
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return yield* state.connections.events(connectionId, requested, params, schema, authorize)
      }),
  }
  const events = await state.run(makeEvents({ ...state.eventOptions, connections }))
  return {
    events,
    entered: () => state.run(Deferred.await(entered)),
    release: () => state.run(Deferred.succeed(release, undefined)),
  }
}

const input = (consumerId: string, name: string, revision: number) => ({
  consumerId,
  revision,
  connectionId: 'feed',
  name,
  arguments: {},
  handlerKey: 'fixture-message',
})

/** A slow older discovery cannot retire the consumer installed by the newer completed subscription. */
async function staleConsumer(state: EventsProbeState) {
  const { events, run, store } = state
  await run(events.grant('feed', 'post.created', {}, true))
  const wait = await delayed(state, 'events/list')
  const first = run(Effect.result(wait.events.subscribe(input('race-monotonic', 'post.created', 1))))
  await wait.entered()
  const newer = await run(events.subscribe(input('race-monotonic', 'post.created', 2)))
  await wait.release()
  const older = await first
  await run(events.unsubscribe({ consumerId: 'race-monotonic', revision: 1 }))
  return (
    Result.isFailure(older) &&
    Predicate.isTagged(older.failure, 'Conflict') &&
    store.activeConsumer('race-monotonic')?.revision === 2 &&
    store.get(newer.subscriptionId)?.status === 'active' &&
    state.fixture.subscriptions.has('sub_post.created')
  )
}

/** A replacement uses a different callback URL, so a delayed old unsubscribe cannot remove it. */
async function cleanupWait(state: EventsProbeState) {
  const { events, run, store } = state
  await run(events.grant('feed', 'post.liked', {}, true))
  const first = await run(events.subscribe(input('race-cleanup', 'post.liked', 1)))
  const wait = await delayed(state, 'events/unsubscribe')
  const retiring = run(wait.events.unsubscribe({ consumerId: 'race-cleanup', revision: 1 }))
  await wait.entered()
  const tombstoned = store.get(first.subscriptionId)?.status === 'tombstone'
  const newer = await run(events.subscribe(input('race-cleanup', 'post.liked', 2)))
  await wait.release()
  await retiring
  const current = store.get(newer.subscriptionId)
  const intact =
    tombstoned &&
    current?.remoteId !== null &&
    current?.remoteId !== undefined &&
    store.activeConsumer('race-cleanup')?.revision === 2 &&
    store.get(newer.subscriptionId)?.status === 'active' &&
    state.fixture.subscriptions.has(current.remoteId)
  await run(events.unsubscribe({ consumerId: 'race-cleanup', revision: 2 }))
  return intact
}

/** An old poll sealed before retirement cannot snapshot consumers from the replacement lease after an alarm wait. */
async function stalePoll(state: EventsProbeState, terminated = false) {
  const { events, run, store, fixture } = state
  const consumerId = terminated ? 'race-poll-terminated' : 'race-poll'
  const first = await run(events.subscribe(input(consumerId, 'post.liked', 1)))
  const remoteId = store.get(first.subscriptionId)?.remoteId
  if (remoteId === undefined || remoteId === null) return false
  const entered = await run(Deferred.make<void>())
  const release = await run(Deferred.make<void>())
  let pollReturned = false
  let waited = false
  const connections: EventsOptions['connections'] = {
    server: state.connections.server,
    events: (connectionId, method, params, schema, authorize) =>
      Effect.gen(function* () {
        const result = yield* state.connections.events(connectionId, method, params, schema, authorize)
        if (method === 'events/poll' && params['name'] === 'post.liked') pollReturned = true
        return result
      }),
  }
  const delayedEvents = await run(
    makeEvents({
      ...state.eventOptions,
      connections,
      wake: (at) =>
        Effect.gen(function* () {
          if (pollReturned && !waited) {
            waited = true
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          yield* state.eventOptions.wake(at)
        }),
    }),
  )
  const eventId = terminated ? 'evt_terminated_poll' : 'evt_stale_poll'
  fixture.cursor = terminated ? 'race-poll-terminated' : 'race-poll'
  fixture.journal.push({
    eventId,
    name: 'post.liked',
    timestamp: new Date(fixture.now).toISOString(),
    data: { inboxCursor: fixture.cursor },
    cursor: fixture.cursor,
  })
  store.patch(first.subscriptionId, { nextPollAt: fixture.now })
  const polling = run(delayedEvents.maintain())
  await run(Deferred.await(entered))
  if (terminated) {
    await fixture.deliver(remoteId, { type: 'terminated', error: { code: -32012 } }, 'msg_terminated_race_poll')
    await run(events.dispatch())
  } else {
    await run(events.unsubscribe({ consumerId, revision: 1 }))
    await run(events.subscribe(input(consumerId, 'post.liked', 2)))
  }
  await run(Deferred.succeed(release, undefined))
  await polling
  const intact =
    store.get(first.subscriptionId)?.status === (terminated ? 'terminated' : 'active') &&
    store.activeConsumer(consumerId)?.revision === (terminated ? 1 : 2) &&
    store.delivery(first.subscriptionId, eventId) === undefined &&
    store.snapshots(first.subscriptionId, eventId).length === 0
  if (terminated) await run(events.subscribe(input(consumerId, 'post.liked', 1)))
  const resumed = store.get(first.subscriptionId)?.status === 'active'
  await run(events.unsubscribe({ consumerId, revision: terminated ? 1 : 2 }))
  return intact && resumed
}

/** A dispatch already holding a control in its work list cannot revive a retired lease or terminate its replacement. */
async function staleControl(state: EventsProbeState, replace: boolean) {
  const { events, run, store, fixture } = state
  const consumerId = replace ? 'race-control-replace' : 'race-control-retire'
  const entered = await run(Deferred.make<void>())
  const release = await run(Deferred.make<void>())
  let calls = 0
  await run(
    events.register(consumerId, ({ envelope }) =>
      Effect.gen(function* () {
        calls += 1
        if ('eventId' in envelope) {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
      }),
    ),
  )
  const args = { ...input(consumerId, 'post.liked', 1), handlerKey: consumerId }
  const first = await run(events.subscribe(args))
  const remoteId = store.get(first.subscriptionId)?.remoteId
  if (remoteId === undefined || remoteId === null) return false
  await fixture.deliver(
    remoteId,
    {
      eventId: `evt_${consumerId}`,
      name: 'post.liked',
      timestamp: new Date(fixture.now).toISOString(),
      data: {},
      cursor: fixture.cursor,
    },
    `evt_${consumerId}`,
  )
  await fixture.deliver(
    remoteId,
    replace ? { type: 'terminated', error: { code: -32012 } } : { type: 'gap', cursor: 'stale-control' },
    `msg_${replace ? 'terminated' : 'gap'}_${consumerId}`,
  )
  const dispatching = run(events.dispatch())
  await run(Deferred.await(entered))
  await run(events.unsubscribe({ consumerId, revision: 1 }))
  if (replace) await run(events.subscribe({ ...args, revision: 2 }))
  await run(Deferred.succeed(release, undefined))
  await dispatching
  const intact = calls === 1 && store.get(first.subscriptionId)?.status === (replace ? 'active' : 'tombstone')
  if (replace) await run(events.unsubscribe({ consumerId, revision: 2 }))
  return intact
}

/** Failed cleanup survives reconstruction without blocking a new, independently addressed lease. */
async function cleanupRecovery(state: EventsProbeState) {
  const { events, run, store } = state
  await run(events.grant('feed', 'post.liked', {}, true))
  const first = await run(events.subscribe(input('race-recovery', 'post.liked', 1)))
  const oldCallback = store.get(first.subscriptionId)?.callbackUrl
  const connections: EventsOptions['connections'] = {
    server: state.connections.server,
    events: (connectionId, method, params, schema, authorize) =>
      method === 'events/unsubscribe'
        ? Effect.fail(new UpstreamMcp({ connectionId, reason: 'transport' }))
        : state.connections.events(connectionId, method, params, schema, authorize),
  }
  const broken = await run(makeEvents({ ...state.eventOptions, connections }))
  const cleanup = await run(broken.unsubscribe({ consumerId: 'race-recovery', revision: 1 }))
  const reconstructed = await run(makeEvents({ ...state.eventOptions, store: new SqliteEventStore(state.db) }))
  const newer = await run(reconstructed.subscribe(input('race-recovery', 'post.liked', 2)))
  const intact =
    !cleanup.remoteCleanup &&
    store.get(newer.subscriptionId)?.callbackUrl !== oldCallback &&
    store.activeConsumer('race-recovery')?.revision === 2 &&
    store.get(newer.subscriptionId)?.status === 'active'
  await run(events.unsubscribe({ consumerId: 'race-recovery', revision: 2 }))
  return intact
}

/** The dispatch guard has already passed; a later remote subscribe can outlive a successful unsubscribe. */
async function inFlightSubscribe(state: EventsProbeState) {
  const { events, run, store, fixture } = state
  const entered = await run(Deferred.make<void>())
  const release = await run(Deferred.make<void>())
  const connections: EventsOptions['connections'] = {
    server: state.connections.server,
    events: (connectionId, method, params, schema, authorize) =>
      Effect.gen(function* () {
        if (method !== 'events/subscribe')
          return yield* state.connections.events(connectionId, method, params, schema, authorize)
        // Model a request already sent: it cannot be recalled by a later local guard.
        yield* authorize
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* state.connections.events(connectionId, method, params, schema, Effect.void)
      }),
  }
  const delayedEvents = await run(makeEvents({ ...state.eventOptions, connections }))
  const first = run(Effect.result(delayedEvents.subscribe(input('race-in-flight', 'post.liked', 1))))
  await run(Deferred.await(entered))
  const cleanup = await run(events.unsubscribe({ consumerId: 'race-in-flight', revision: 1 }))
  const newer = await run(events.subscribe(input('race-in-flight', 'post.liked', 2)))
  const current = store.get(newer.subscriptionId)
  await run(Deferred.succeed(release, undefined))
  const old = await first
  return (
    cleanup.remoteCleanup &&
    Result.isFailure(old) &&
    current?.remoteId !== null &&
    current?.remoteId !== undefined &&
    fixture.subscriptions.get(current.remoteId)?.url === current.callbackUrl &&
    store.get(newer.subscriptionId)?.status === 'active'
  )
}

export async function eventsRaceProbe(state: EventsProbeState) {
  return {
    staleConsumer: await staleConsumer(state),
    cleanupWait: await cleanupWait(state),
    stalePoll: await stalePoll(state),
    terminatedPoll: await stalePoll(state, true),
    staleControlRetire: await staleControl(state, false),
    staleControlReplace: await staleControl(state, true),
    cleanupRecovery: await cleanupRecovery(state),
    inFlightSubscribe: await inFlightSubscribe(state),
  }
}
