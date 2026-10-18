import { describe, expect, it } from '@effect/vitest'
import { EVERYTHING, type SourceView, type TopicView, type WorkspacePlanProposal } from '@goblin/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { PiReceipt } from 'agents/harness/pi'
import type { Submission } from '@earendil-works/pi-durable'
import { ChatOperations } from '../src/chats/service.ts'
import type { Receipt } from '../src/chats/receipts.ts'
import { BudgetExhausted, Conflict, Forbidden, NotFound, UpstreamMcp, attemptSync } from '../src/http/errors.ts'
import { routinesOf } from '../src/layers/routines.ts'
import { WorkspacePlansLive } from '../src/layers/workspace-plans.ts'
import { Resident } from '../src/mcp/service.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { RoutineControl, Routines } from '../src/routines/service.ts'
import { RoutineStore } from '../src/routines/store.ts'
import { Sources } from '../src/sources/service.ts'
import { appTopics } from '../src/storage/topics.ts'
import { Topics } from '../src/topics/service.ts'
import { applyWorkspacePlan, proposeWorkspacePlan, retryWorkspacePlan } from '../src/workspace-plans/program.ts'
import { WorkspacePlans } from '../src/workspace-plans/service.ts'
import { WorkspacePlanStore } from '../src/workspace-plans/store.ts'
import { durable } from './chats-sqlite.ts'
import { database, stub, sqliteDb } from './http/api/fixture.ts'
import { PAYLOAD_SETUP } from './sources-fixture.ts'
import { fake } from './fake.ts'

const TOPIC: TopicView = {
  id: 4,
  name: 'Household',
  conversation: '4',
  searchExcluded: false,
  revision: 1,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: 1,
}

const PROPOSAL: WorkspacePlanProposal = {
  title: 'Household setup',
  purpose: 'Messages and a daily reminder.',
  sources: [
    { connectionId: 'chat', title: 'Shared chat', setup: { ...PAYLOAD_SETUP, newKeys: { to: 'topic', topic: 4 } } },
  ],
  routines: [
    {
      topic: 4,
      definition: {
        title: 'Daily reminder',
        trigger: { kind: 'cron', expression: '0 9 * * *' },
        timezone: 'UTC',
        tellMe: { on: true, copy: false },
        handTo: { kind: 'none' },
      },
    },
  ],
}

/** Real plan/routine SQLite stores, with external Source subscription and scheduler ports controlled by the test. */
function world(wait: Effect.Effect<void> = Effect.void) {
  const db = database()
  db.insert(appTopics)
    .values({
      id: TOPIC.id,
      name: TOPIC.name,
      chatId: TOPIC.conversation,
      revision: TOPIC.revision,
      setup: JSON.stringify(TOPIC.setup),
      createdBy: TOPIC.createdBy,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  const store = new WorkspacePlanStore(durable(db))
  const routines = new RoutineStore(durable(db), 'owner')
  const sources = new Map<string, SourceView>()
  const calls = { source: 0, routine: 0 }
  const continuations = {
    sent: new Set<string>(),
    kept: new Set<string>(),
    receipts: new Map<string, Receipt>(),
    attempts: 0,
  }
  const state = { topic: TOPIC, allowed: true, failRoutine: false, failPrepare: false, exhausted: false }
  const readSource = (id: string) => {
    const source = sources.get(id)
    if (source === undefined) throw new NotFound({ what: 'source' })
    return source
  }
  const sourceLayer = stub(Sources, {
    propose: (proposal) =>
      attemptSync(() => {
        if (state.failPrepare) throw new UpstreamMcp({ connectionId: 'chat', reason: 'transport' })
        const id = `src_${'a'.repeat(32)}`
        const prior = sources.get(id)
        if (prior !== undefined) return prior
        const source: SourceView = {
          id,
          connectionId: proposal.connectionId,
          title: proposal.title,
          label: 'Chat',
          setup: proposal.setup,
          revision: 1,
          state: 'proposed',
          proposedBy: 'agent',
          waiting: [],
          createdAt: 0,
          updatedAt: 0,
        }
        sources.set(id, source)
        return source
      }),
    routes: (id) => attemptSync(() => ({ source: readSource(id), routes: [] })),
    confirm: (id, revision) =>
      Effect.gen(function* () {
        calls.source += 1
        yield* wait
        return yield* attemptSync(() => {
          const source = readSource(id)
          if (source.revision !== revision) throw new Conflict({ reason: 'stale' })
          const active: SourceView = { ...source, state: 'active' }
          sources.set(id, active)
          return active
        })
      }),
  })
  const layer = Layer.mergeAll(
    WorkspacePlansLive.pipe(Layer.provide(sqliteDb(db))),
    SingleFlight.layer,
    sourceLayer,
    Layer.succeed(Routines, routinesOf(routines)),
    stub(ChatOperations, {
      receipt: (_chat, operationId) => Effect.sync(() => Option.fromNullishOr(continuations.receipts.get(operationId))),
      send: (input) =>
        Effect.suspend(() => {
          continuations.attempts += 1
          if (state.exhausted) return Effect.fail(new BudgetExhausted({ limit: 1000, resetsAt: 86400 }))
          continuations.sent.add(input.operationId)
          continuations.receipts.set(input.operationId, {
            chat: input.chat,
            operationId: input.operationId,
            session: '1',
            admittedAt: 1,
            kind: 'workspace_setup',
            origin: 'system',
            state: 'submitted',
          })
          return Effect.succeed(fake<PiReceipt>({}))
        }),
      passiveWrite: (_chat, input) =>
        Effect.sync(() => {
          continuations.kept.add(input.requestId)
          continuations.receipts.set(input.requestId, {
            chat: '1',
            operationId: input.requestId,
            session: '1',
            admittedAt: 1,
            kind: 'write:app.workspace_setup',
            origin: 'system',
            state: 'written',
          })
          return fake<Submission>({})
        }),
    }),
    stub(Topics, { get: () => Effect.sync(() => state.topic) }),
    stub(Resident, {
      require: () =>
        Effect.suspend(() => (state.allowed ? Effect.void : Effect.fail(new Forbidden({ reason: 'revoked' })))),
    }),
    stub(RoutineControl, {
      confirmEvents: () =>
        Effect.suspend(() => {
          calls.routine += 1
          return state.failRoutine
            ? Effect.fail(new UpstreamMcp({ connectionId: 'chat', reason: 'transport' }))
            : Effect.void
        }),
      reconcile: Effect.sync(() => {
        for (const routine of routines.list())
          if (routine.state === 'activating') routines.markActive(routine.id, routine.revision, null, 1)
      }),
    }),
  )
  return { db, store, routines, sources, calls, continuations, state, layer }
}

describe('workspace setup reviews', () => {
  it.effect('keeps a failed preparation reviewable and retries without granting or activating anything', () => {
    const fixture = world()
    return Effect.gen(function* () {
      fixture.state.failPrepare = true
      const waiting = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-prepare')
      expect(waiting).toMatchObject({ state: 'preparing', problem: 'UpstreamMcp:transport' })
      expect(yield* Effect.flip(applyWorkspacePlan(waiting.id, 1))).toMatchObject({
        _tag: 'Conflict',
        reason: 'workspace_plan_not_ready',
      })
      fixture.state.failPrepare = false
      const prepared = yield* retryWorkspacePlan(waiting.id, 1)
      expect(prepared).toMatchObject({ state: 'proposed', problem: null })
      expect(prepared.items).toHaveLength(2)
      expect(fixture.calls).toEqual({ source: 0, routine: 0 })
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('keeps accepted continuation receipts across a progress-save interruption', () => {
    const fixture = world()
    return Effect.gen(function* () {
      const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-continuation')
      const applied = yield* applyWorkspacePlan(plan.id, 1)
      // Simulate reconstruction after send acceptance but before saving continuation progress.
      new WorkspacePlanStore(durable(fixture.db)).save({ ...applied, continuation: 'pending' })
      fixture.state.exhausted = true
      expect(yield* applyWorkspacePlan(plan.id, 1)).toMatchObject({ continuation: 'sent' })
      expect(fixture.continuations.attempts).toBe(1)
      expect(fixture.continuations.kept.size).toBe(0)
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('reconstructs a passive continuation without turning it into another model submission', () => {
    const fixture = world()
    return Effect.gen(function* () {
      const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-kept')
      fixture.state.exhausted = true
      const applied = yield* applyWorkspacePlan(plan.id, 1)
      new WorkspacePlanStore(durable(fixture.db)).save({ ...applied, continuation: 'pending' })
      fixture.state.exhausted = false
      expect(yield* applyWorkspacePlan(plan.id, 1)).toMatchObject({ continuation: 'kept' })
      expect(fixture.continuations.attempts).toBe(1)
      expect(fixture.continuations.sent.size).toBe(0)
      expect(fixture.continuations.kept.size).toBe(1)
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('stops between steps when a Topic changes during the Source confirmation', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = world(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)))
      yield* Effect.gen(function* () {
        const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-topic-race')
        const applying = yield* Effect.forkChild(Effect.flip(applyWorkspacePlan(plan.id, 1)))
        yield* Deferred.await(entered)
        fixture.state.topic = { ...TOPIC, revision: 2 }
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(applying)).toMatchObject({ _tag: 'Conflict', reason: 'workspace_plan_topic_changed' })
        expect(fixture.store.get(plan.id)).toMatchObject({ state: 'attention', completed: [0] })
        expect(fixture.calls).toEqual({ source: 1, routine: 0 })
        expect(fixture.continuations.sent.size).toBe(0)
      }).pipe(Effect.provide(fixture.layer))
    }),
  )
  it.effect(
    'prepares existing primitives without activating them and retains the exact review after reconstruction',
    () => {
      const fixture = world()
      return Effect.gen(function* () {
        const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-1')
        expect(plan.state).toBe('proposed')
        expect(plan.items.map((item) => item.kind)).toEqual(['source', 'routine'])
        expect(fixture.calls).toEqual({ source: 0, routine: 0 })
        expect(yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-1')).toEqual(plan)
        expect(fixture.routines.list()).toHaveLength(1)
        expect(fixture.sources.size).toBe(1)
        const reconstructed = new WorkspacePlanStore(durable(fixture.db))
        expect(reconstructed.get(plan.id)).toEqual(plan)
        expect(reconstructed.proposal(plan.id)).toEqual(PROPOSAL)
        expect(
          yield* Effect.flip(proposeWorkspacePlan({ ...PROPOSAL, title: 'Changed intent' }, '1', 'setup-1')),
        ).toMatchObject({ _tag: 'Conflict', reason: 'workspace_plan_operation' })
      }).pipe(Effect.provide(fixture.layer))
    },
  )

  it.effect('resumes a partial activation without repeating the completed Source', () => {
    const fixture = world()
    return Effect.gen(function* () {
      const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-partial')
      fixture.state.failRoutine = true
      expect(yield* Effect.flip(applyWorkspacePlan(plan.id, plan.revision))).toMatchObject({ _tag: 'UpstreamMcp' })
      expect(fixture.store.get(plan.id)).toMatchObject({ state: 'attention', completed: [0] })
      fixture.state.failRoutine = false
      const applied = yield* applyWorkspacePlan(plan.id, plan.revision)
      expect(applied).toMatchObject({ state: 'ready', completed: [0, 1] })
      expect(fixture.calls).toEqual({ source: 1, routine: 2 })
      expect(applied.continuation).toBe('sent')
      expect(fixture.continuations.sent.size).toBe(1)
      expect(yield* applyWorkspacePlan(plan.id, plan.revision)).toEqual(applied)
      expect(fixture.calls).toEqual({ source: 1, routine: 2 })
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('keeps the activation result for the next message when the model budget is exhausted', () => {
    const fixture = world()
    return Effect.gen(function* () {
      const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-budget')
      fixture.state.exhausted = true
      const applied = yield* applyWorkspacePlan(plan.id, 1)
      expect(applied).toMatchObject({ state: 'ready', continuation: 'kept' })
      expect(fixture.continuations.sent.size).toBe(0)
      expect(fixture.continuations.kept.size).toBe(1)
      expect(yield* applyWorkspacePlan(plan.id, 1)).toEqual(applied)
      expect(fixture.continuations.kept.size).toBe(1)
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('refuses changed Sources, Topics, review revisions and revoked authority before activation', () => {
    const fixture = world()
    return Effect.gen(function* () {
      const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-revisions')
      expect(yield* Effect.flip(applyWorkspacePlan(plan.id, 2))).toMatchObject({
        _tag: 'Conflict',
        reason: 'workspace_plan_revision',
      })
      fixture.state.topic = { ...TOPIC, revision: 2 }
      expect(yield* Effect.flip(applyWorkspacePlan(plan.id, 1))).toMatchObject({
        _tag: 'Conflict',
        reason: 'workspace_plan_topic_changed',
      })
      fixture.state.topic = TOPIC
      const source = [...fixture.sources.values()][0]
      if (source === undefined) throw new Error('proposal did not create its Source')
      fixture.sources.set(source.id, { ...source, revision: 2 })
      expect(yield* Effect.flip(applyWorkspacePlan(plan.id, 1))).toMatchObject({
        _tag: 'Conflict',
        reason: 'workspace_plan_source_changed',
      })
      fixture.state.allowed = false
      expect(yield* Effect.flip(applyWorkspacePlan(plan.id, 1))).toMatchObject({ _tag: 'Forbidden' })
      expect(fixture.calls).toEqual({ source: 0, routine: 0 })
    }).pipe(Effect.provide(fixture.layer))
  })

  it.effect('joins duplicate activations but rejects a stale caller while the first activation is waiting', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = world(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)))
      yield* Effect.gen(function* () {
        const plan = yield* proposeWorkspacePlan(PROPOSAL, '1', 'setup-concurrent')
        const first = yield* Effect.forkChild(applyWorkspacePlan(plan.id, 1))
        yield* Deferred.await(entered)
        expect(yield* Effect.flip(applyWorkspacePlan(plan.id, 2))).toMatchObject({
          _tag: 'Conflict',
          reason: 'workspace_plan_revision',
        })
        const second = yield* Effect.forkChild(applyWorkspacePlan(plan.id, 1))
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second))
        expect(fixture.calls).toEqual({ source: 1, routine: 1 })
        expect((yield* (yield* WorkspacePlans).get(plan.id)).state).toBe('ready')
      }).pipe(Effect.provide(fixture.layer))
    }),
  )
})
