import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { EventContext } from '../src/mcp/events/dispatcher.ts'
import type { Consumer, Receipt, Subscription } from '../src/mcp/events/store.ts'
import { Events, McpConnections, McpGrants, McpServers, Resident } from '../src/mcp/service.ts'
import type { McpConnectionSnapshot } from '../src/mcp/connections/types.ts'
import { Personas } from '../src/personas/service.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput } from '../src/runtime/input.ts'
import {
  SOURCE_HANDLER,
  confirmSource,
  changeSourceReplyResult,
  consumeSourceEvent,
  proposeSource,
  pauseSource,
  resumeSource,
  wakeSources,
} from '../src/sources/program.ts'
import { sourceRow } from '../src/sources/store.ts'
import type { TopicView } from '@goblin/contracts'
import { Topics } from '../src/topics/service.ts'
import { fake } from './fake.ts'
import { stub } from './http/api/fixture.ts'
import { FEED_READ, POST_CREATED, PAYLOAD_SETUP, message, sourceWorld } from './sources-fixture.ts'

/** What the fakes of the MCP host saw: grants, tools allowed, subscriptions made and ended, alarms and offers. */
type Calls = {
  readonly grants: string[]
  readonly tools: string[]
  readonly subscribed: { readonly consumerId: string; readonly revision: number; readonly handlerKey: string }[]
  readonly unsubscribed: number[]
  readonly scheduled: number[]
  readonly settled: string[]
}

type EventWaits = {
  readonly subscribe?: (revision: number) => Effect.Effect<void>
  readonly unsubscribe?: (revision: number) => Effect.Effect<void>
}

/** The chat server's connection: `post.created`, its inbox and its send tool. */
const SNAPSHOT: McpConnectionSnapshot = {
  config: { connectionId: 'chat', endpoint: 'https://chat.example/mcp' },
  capabilities: { events: {} },
  tools: [
    { ...FEED_READ, inputSchema: { type: 'object' } },
    { name: 'post_reply', inputSchema: { type: 'object' } },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [],
}

/** Events that record each grant, subscription and unsubscription, and answer each lease's status from `leases`. */
const fakeEvents = (calls: Calls, leases: Map<string, Subscription['status']>, waits: EventWaits) => {
  const consumers = new Map<string, Consumer>()
  return stub(Events, {
    catalog: () => Effect.succeed([POST_CREATED]),
    grant: (_id, name, args) => Effect.sync(() => void calls.grants.push(`${name}:${JSON.stringify(args)}`)),
    subscribe: (input) =>
      Effect.gen(function* () {
        calls.subscribed.push({ consumerId: input.consumerId, revision: input.revision, handlerKey: input.handlerKey })
        const subscriptionId = `sub-${String(input.revision)}`
        leases.set(subscriptionId, 'active')
        consumers.set(
          input.consumerId,
          fake<Consumer>({ consumerId: input.consumerId, revision: input.revision, subscriptionId }),
        )
        yield* waits.subscribe?.(input.revision) ?? Effect.void
        return { subscriptionId, status: 'active' }
      }),
    unsubscribe: ({ revision }) =>
      Effect.gen(function* () {
        calls.unsubscribed.push(revision)
        yield* waits.unsubscribe?.(revision) ?? Effect.void
        return { retired: true, remoteCleanup: true }
      }),
    activeConsumer: (consumerId) => Effect.succeed(Option.fromUndefinedOr(consumers.get(consumerId))),
    subscription: (id) =>
      Effect.succeed(
        Option.map(Option.fromUndefinedOr(leases.get(id)), (status) => fake<Subscription>({ id, status })),
      ),
  })
}

/** The connection, its labels and tool grants (whose versions `versions` holds), recording what they were asked. */
const fakeHost = (calls: Calls, versions: ReadonlyMap<string, string>) =>
  Layer.mergeAll(
    stub(McpConnections, { connect: () => Effect.succeed(SNAPSHOT), server: () => Effect.succeed(SNAPSHOT.config) }),
    stub(McpServers, {
      labels: () => Effect.succeed(new Map([['chat', 'Chat']])),
      settleEvents: (connectionId, state) => Effect.sync(() => void calls.settled.push(`${connectionId}:${state}`)),
    }),
    stub(McpGrants, {
      setTool: (_id, name) => Effect.sync(() => (calls.tools.push(name), [])),
      policy: (_id, name) =>
        Effect.succeed(
          Option.map(Option.fromUndefinedOr(versions.get(name)), (version) => ({ askFirst: false, version })),
        ),
    }),
  )

/**
 * The world a Source is confirmed and kept bound in, over fakes of the MCP host and Events, with Topic 4 open.
 */
const programWorld = (waits: EventWaits = {}) =>
  Effect.gen(function* () {
    const world = yield* sourceWorld()
    const calls: Calls = { grants: [], tools: [], subscribed: [], unsubscribed: [], scheduled: [], settled: [] }
    const versions = new Map([
      ['post_reply', 'v1'],
      ['feed_read', 'v1'],
    ])
    const leases = new Map<string, Subscription['status']>()
    const services = Layer.mergeAll(
      Layer.succeed(Db, world.db),
      stub(AgentInput, { scheduleSources: (seconds) => void calls.scheduled.push(seconds) }),
      stub(Resident, { require: () => Effect.void }),
      fakeHost(calls, versions),
      fakeEvents(calls, leases, waits),
      stub(Topics, { get: () => Effect.succeed(fake<TopicView>({ id: 4, name: 'Travel', revision: 1 })) }),
      stub(Personas, { active: Effect.succeed([]) }),
    )
    const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof services>>) =>
      Effect.provide(program, services)
    return { ...world, calls, versions, leases, run }
  })

/** A delivery to the Source's subscription at `revision`, as the Events dispatcher hands one to its handler. */
const delivery = (sourceId: string, revision: number, envelope: EventContext['envelope']): EventContext => ({
  subscription: fake<Subscription>({ id: `sub-${String(revision)}`, name: 'post.created' }),
  consumer: fake<Consumer>({ consumerId: `source:${sourceId}`, revision }),
  receipt: fake<Receipt>({}),
  envelope,
})

/** The owner's message `m1` in the private chat, as the server's event carries it. */
const OCCURRENCE = {
  eventId: 'e1',
  name: 'post.created',
  timestamp: new Date(0).toISOString(),
  data: message('m1'),
}

const PROPOSAL = {
  connectionId: 'chat',
  title: 'Chat',
  setup: { ...PAYLOAD_SETUP, newKeys: { to: 'topic' as const, topic: 4 } },
}

describe('proposing and confirming a Source (ADR 0066)', () => {
  it.effect('an older confirmation cannot activate edited rules or retire the newer confirmed binding', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let subscriptions = 0
      const { db, engine, ports, calls, run } = yield* programWorld({
        subscribe: () =>
          ++subscriptions === 1
            ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
            : Effect.void,
      })
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-confirm-race' }, {}))
      const first = yield* Effect.forkChild(Effect.flip(run(confirmSource(engine, ports, proposed.id, 1))))
      yield* Deferred.await(entered)
      const result = { accepted: { pointer: '/ok', equals: true } }
      yield* run(changeSourceReplyResult(proposed.id, { revision: 1, result }))
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'proposed', revision: 2, binding: null })
      yield* run(confirmSource(engine, ports, proposed.id, 2))
      const newer = sourceRow(db, proposed.id)?.binding
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: 'Conflict', reason: 'stale' })
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'active', revision: 2, binding: newer })
      expect(calls.subscribed).toHaveLength(2)
      expect(calls.subscribed[0]?.revision).not.toBe(newer)
      expect(calls.unsubscribed).toEqual([calls.subscribed[0]?.revision])
      expect(calls.unsubscribed).not.toContain(newer)
    }),
  )

  it.effect('editing reply rules retires the binding and requires confirmation of the new exact revision', () =>
    Effect.gen(function* () {
      const { db, engine, ports, calls, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-rules' }, {}))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const binding = sourceRow(db, proposed.id)?.binding
      const result = { accepted: { pointer: '/ok', equals: true } }
      const changed = yield* run(changeSourceReplyResult(proposed.id, { revision: 1, result }))
      expect(changed).toMatchObject({ revision: 2, state: 'proposed', setup: { reply: { result } } })
      expect(sourceRow(db, proposed.id)).toMatchObject({ binding: null, confirmedAt: null })
      expect(calls.unsubscribed).toEqual([binding])
      expect(calls.subscribed).toHaveLength(1)
      expect(yield* Effect.flip(run(confirmSource(engine, ports, proposed.id, 1)))).toMatchObject({ _tag: 'Conflict' })
      expect(
        yield* Effect.flip(run(changeSourceReplyResult(proposed.id, { revision: 1, result: null }))),
      ).toMatchObject({ _tag: 'Conflict' })
      const cleared = yield* run(changeSourceReplyResult(proposed.id, { revision: 2, result: null }))
      expect(cleared.setup.reply?.result).toBeUndefined()
      expect(cleared.revision).toBe(3)
    }),
  )
  it.effect("refuses a proposal whose pointer the server's schema does not have", () =>
    Effect.gen(function* () {
      const { run } = yield* programWorld()
      const { reply: _, ...noReply } = PROPOSAL.setup
      const setup = { ...noReply, key: [{ name: 'room', pointer: '/room' }] }
      const refused = yield* Effect.flip(run(proposeSource({ ...PROPOSAL, setup, operationId: 'op-1' }, {})))
      expect(refused).toMatchObject({
        _tag: 'InvalidInput',
        reason: expect.stringContaining('key.room points at /room'),
      })
    }),
  )

  it.effect('grants the event and tools, subscribes it and binds it to the endpoint and grants on Confirm', () =>
    Effect.gen(function* () {
      const { db, engine, ports, calls, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, {}))
      expect(proposed).toMatchObject({ state: 'proposed', revision: 1, label: 'Chat', waiting: [] })
      expect(yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, {}))).toMatchObject({
        id: proposed.id,
      })
      expect(yield* Effect.flip(run(confirmSource(engine, ports, proposed.id, 2)))).toMatchObject({
        _tag: 'Conflict',
        reason: 'stale',
      })
      const confirmed = yield* run(confirmSource(engine, ports, proposed.id, 1))
      expect(confirmed).toMatchObject({ state: 'active', bound: { endpoint: 'https://chat.example/mcp' } })
      expect(calls.grants).toEqual(['post.created:{"chat":"all"}'])
      expect(calls.tools).toEqual(['post_reply'])
      expect(calls.subscribed).toEqual([
        { consumerId: `source:${proposed.id}`, revision: expect.any(Number), handlerKey: SOURCE_HANDLER },
      ])
      expect(sourceRow(db, proposed.id)?.binding).toBe(calls.subscribed[0]?.revision)
      expect(calls.settled).toEqual(['chat:done'])
    }),
  )
})

describe('keeping a Source bound (ADR 0066)', () => {
  it.effect('a delayed unbind cannot clear the binding made by a newer resume', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let cleanups = 0
      const { db, engine, ports, calls, run } = yield* programWorld({
        unsubscribe: () =>
          ++cleanups === 1
            ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
            : Effect.void,
      })
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-unbind-race' }, {}))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const original = sourceRow(db, proposed.id)?.binding
      const pausing = yield* Effect.forkChild(run(pauseSource(proposed.id)))
      yield* Deferred.await(entered)
      yield* run(resumeSource(engine, ports, proposed.id))
      const newer = sourceRow(db, proposed.id)?.binding
      expect(newer).not.toBe(original)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pausing)
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'active', binding: newer })
      expect(calls.unsubscribed).not.toContain(newer)
    }),
  )

  it.effect('an alarm subscription cannot overwrite a Source revision edited while it waits', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let subscriptions = 0
      const { db, engine, ports, calls, leases, run } = yield* programWorld({
        subscribe: () =>
          ++subscriptions === 2
            ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
            : Effect.void,
      })
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-alarm-race' }, {}))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const original = sourceRow(db, proposed.id)?.binding
      leases.set(`sub-${String(original)}`, 'terminated')
      const waking = yield* Effect.forkChild(run(wakeSources(engine, ports, () => Effect.void)))
      yield* Deferred.await(entered)
      yield* run(changeSourceReplyResult(proposed.id, { revision: 1, result: null }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(waking)
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'proposed', revision: 2, binding: null })
      expect(calls.unsubscribed).toContain(calls.subscribed[1]?.revision)
    }),
  )

  it.effect('takes an owner message from an event, and subscribes again when the server ends the subscription', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, calls, leases, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, {}))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const binding = sourceRow(db, proposed.id)?.binding ?? 0
      yield* run(consumeSourceEvent(engine, ports, delivery(proposed.id, binding, OCCURRENCE)))
      expect(seen.turns.map(({ turn }) => [turn.topic, turn.author])).toEqual([[4, 'Chat · chat dm']])
      leases.set(`sub-${String(binding)}`, 'terminated')
      yield* run(consumeSourceEvent(engine, ports, delivery(proposed.id, binding, { type: 'terminated' })))
      expect(sourceRow(db, proposed.id)?.resubscribeDue).toBe(true)
      expect(calls.scheduled).toEqual([1])
      yield* run(wakeSources(engine, ports, () => Effect.void))
      expect(calls.subscribed).toHaveLength(2)
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'active', resubscribeDue: false })
      expect(sourceRow(db, proposed.id)?.binding).not.toBe(binding)
      expect(calls.unsubscribed).toEqual([binding])
    }),
  )

  it.effect('pauses for review, and ends its subscription, once a tool grant it was confirmed with changed', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, calls, versions, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, {}))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const binding = sourceRow(db, proposed.id)?.binding ?? 0
      versions.set('post_reply', 'v2')
      yield* run(consumeSourceEvent(engine, ports, delivery(proposed.id, binding, OCCURRENCE)))
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'paused', paused: 'review' })
      expect(seen.turns).toEqual([])
      yield* run(wakeSources(engine, ports, () => Effect.void))
      expect(calls.unsubscribed).toEqual([binding])
      expect(sourceRow(db, proposed.id)?.binding).toBeNull()
    }),
  )
})
