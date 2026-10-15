import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
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
  consumeSourceEvent,
  proposeSource,
  wakeSources,
} from '../src/sources/program.ts'
import { sourceRow } from '../src/sources/store.ts'
import type { TopicView } from '@goblin/contracts'
import { Topics } from '../src/topics/service.ts'
import { fake } from './fake.ts'
import { stub } from './http/api/fixture.ts'
import { INBOX_READ, MESSAGE_RECEIVED, PAYLOAD_SETUP, message, sourceWorld } from './sources-fixture.ts'

/** What the fakes of the MCP host saw: grants, tools allowed, subscriptions made and ended, alarms and offers. */
type Calls = {
  readonly grants: string[]
  readonly tools: string[]
  readonly subscribed: { readonly consumerId: string; readonly revision: number; readonly handlerKey: string }[]
  readonly unsubscribed: number[]
  readonly scheduled: number[]
  readonly settled: string[]
}

/** The chat server's connection: `message.received`, its inbox and its send tool. */
const SNAPSHOT: McpConnectionSnapshot = {
  config: { connectionId: 'chat', endpoint: 'https://chat.example/mcp' },
  capabilities: { events: {} },
  tools: [
    { ...INBOX_READ, inputSchema: { type: 'object' } },
    { name: 'message_send', inputSchema: { type: 'object' } },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [],
}

/** Events that record each grant, subscription and unsubscription, and answer each lease's status from `leases`. */
const fakeEvents = (calls: Calls, leases: Map<string, Subscription['status']>) => {
  const consumers = new Map<string, Consumer>()
  return stub(Events, {
    catalog: () => Effect.succeed([MESSAGE_RECEIVED]),
    grant: (_id, name, args) => Effect.sync(() => void calls.grants.push(`${name}:${JSON.stringify(args)}`)),
    subscribe: (input) =>
      Effect.sync(() => {
        calls.subscribed.push({ consumerId: input.consumerId, revision: input.revision, handlerKey: input.handlerKey })
        const subscriptionId = `sub-${String(input.revision)}`
        leases.set(subscriptionId, 'active')
        consumers.set(
          input.consumerId,
          fake<Consumer>({ consumerId: input.consumerId, revision: input.revision, subscriptionId }),
        )
        return { subscriptionId, status: 'active' }
      }),
    unsubscribe: ({ revision }) =>
      Effect.sync(() => {
        calls.unsubscribed.push(revision)
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
const programWorld = () =>
  Effect.gen(function* () {
    const world = yield* sourceWorld()
    const calls: Calls = { grants: [], tools: [], subscribed: [], unsubscribed: [], scheduled: [], settled: [] }
    const versions = new Map([
      ['message_send', 'v1'],
      ['inbox_read', 'v1'],
    ])
    const leases = new Map<string, Subscription['status']>()
    const services = Layer.mergeAll(
      Layer.succeed(Db, world.db),
      stub(AgentInput, { scheduleSources: (seconds) => void calls.scheduled.push(seconds) }),
      stub(Resident, { require: () => Effect.void }),
      fakeHost(calls, versions),
      fakeEvents(calls, leases),
      stub(Topics, { get: () => Effect.succeed(fake<TopicView>({ id: 4, name: 'Travel', revision: 1 })) }),
      stub(Personas, { active: Effect.succeed([]) }),
    )
    const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof services>>) =>
      Effect.provide(program, services)
    return { ...world, calls, versions, leases, run }
  })

/** A delivery to the Source's subscription at `revision`, as the Events dispatcher hands one to its handler. */
const delivery = (sourceId: string, revision: number, envelope: EventContext['envelope']): EventContext => ({
  subscription: fake<Subscription>({ id: `sub-${String(revision)}`, name: 'message.received' }),
  consumer: fake<Consumer>({ consumerId: `source:${sourceId}`, revision }),
  receipt: fake<Receipt>({}),
  envelope,
})

/** The owner's message `m1` in the private chat, as the server's event carries it. */
const OCCURRENCE = {
  eventId: 'e1',
  name: 'message.received',
  timestamp: new Date(0).toISOString(),
  data: message('m1'),
}

const PROPOSAL = {
  connectionId: 'chat',
  title: 'Chat',
  setup: { ...PAYLOAD_SETUP, newKeys: { to: 'topic' as const, topic: 4 } },
}

describe('proposing and confirming a Source (ADR 0066)', () => {
  it.effect("refuses a proposal whose pointer the server's schema does not have", () =>
    Effect.gen(function* () {
      const { run } = yield* programWorld()
      const { reply: _, ...noReply } = PROPOSAL.setup
      const setup = { ...noReply, key: [{ name: 'room', pointer: '/room' }] }
      const refused = yield* Effect.flip(
        run(proposeSource({ ...PROPOSAL, setup, operationId: 'op-1' }, { actor: 'agent' })),
      )
      expect(refused).toMatchObject({
        _tag: 'InvalidInput',
        reason: expect.stringContaining('key.room points at /room'),
      })
    }),
  )

  it.effect('grants the event and tools, subscribes it and binds it to the endpoint and grants on Confirm', () =>
    Effect.gen(function* () {
      const { db, engine, ports, calls, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, { actor: 'owner' }))
      expect(proposed).toMatchObject({ state: 'proposed', revision: 1, label: 'Chat', waiting: [] })
      expect(yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, { actor: 'owner' }))).toMatchObject({
        id: proposed.id,
      })
      expect(yield* Effect.flip(run(confirmSource(engine, ports, proposed.id, 2)))).toMatchObject({
        _tag: 'Conflict',
        reason: 'stale',
      })
      const confirmed = yield* run(confirmSource(engine, ports, proposed.id, 1))
      expect(confirmed).toMatchObject({ state: 'active', bound: { endpoint: 'https://chat.example/mcp' } })
      expect(calls.grants).toEqual(['message.received:{"chat":"all"}'])
      expect(calls.tools).toEqual(['message_send'])
      expect(calls.subscribed).toEqual([
        { consumerId: `source:${proposed.id}`, revision: expect.any(Number), handlerKey: SOURCE_HANDLER },
      ])
      expect(sourceRow(db, proposed.id)?.binding).toBe(calls.subscribed[0]?.revision)
      expect(calls.settled).toEqual(['chat:done'])
    }),
  )
})

describe('keeping a Source bound (ADR 0066)', () => {
  it.effect('takes an owner message from an event, and subscribes again when the server ends the subscription', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, calls, leases, run } = yield* programWorld()
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, { actor: 'owner' }))
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
      const proposed = yield* run(proposeSource({ ...PROPOSAL, operationId: 'op-1' }, { actor: 'owner' }))
      yield* run(confirmSource(engine, ports, proposed.id, 1))
      const binding = sourceRow(db, proposed.id)?.binding ?? 0
      versions.set('message_send', 'v2')
      yield* run(consumeSourceEvent(engine, ports, delivery(proposed.id, binding, OCCURRENCE)))
      expect(sourceRow(db, proposed.id)).toMatchObject({ state: 'paused', paused: 'review' })
      expect(seen.turns).toEqual([])
      yield* run(wakeSources(engine, ports, () => Effect.void))
      expect(calls.unsubscribed).toEqual([binding])
      expect(sourceRow(db, proposed.id)?.binding).toBeNull()
    }),
  )
})
