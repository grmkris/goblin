import type { TopicView, WorkspacePlanItem, WorkspacePlanProposal } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Conflict, InvalidInput, attempt } from '../http/errors.ts'
import { requireResident } from '../mcp/service.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { prepareRoutine, routineChange } from '../routines/program.ts'
import { Routines } from '../routines/service.ts'
import { Sources } from '../sources/service.ts'
import { Topics } from '../topics/service.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { outcomeOf } from '../telemetry/attributes.ts'
import { WorkspacePlans } from './service.ts'
import { continueWorkspacePlan } from './continuation.ts'

/** Prepare existing primitive proposals; every retry uses the same Source/Routine operation id. */
const prepareWorkspacePlan = Effect.fn('workspacePlans.prepare')(function* (id: string) {
  const plans = yield* WorkspacePlans
  const plan = yield* plans.get(id)
  if (plan.state !== 'preparing') return plan
  const proposal = yield* plans.proposal(id)
  const topicIds = [
    ...new Set([
      ...proposal.routines.map((routine) => routine.topic),
      ...proposal.sources.flatMap(({ setup }) => ('topic' in setup.newKeys ? [setup.newKeys.topic] : [])),
    ]),
  ]
  const topics = yield* Effect.forEach(topicIds, (topicId) => Topics.use((registry) => registry.get(topicId)))
  if (topics.some((topic) => topic.archivedAt !== undefined))
    return yield* new InvalidInput({ reason: 'topic_archived' })
  const writes: (() => WorkspacePlanItem)[] = []
  for (const [index, source] of proposal.sources.entries()) {
    const write = yield* Sources.use((sources) =>
      sources.prepare({ ...source, operationId: `${id}:source:${String(index)}` }, { actor: 'agent', chat: plan.chat }),
    )
    writes.push(() => ({ kind: 'source', source: write() }))
  }
  for (const [index, routine] of proposal.routines.entries()) {
    const write = yield* prepareRoutine(routine.definition, `${id}:routine:${String(index)}`, routine.topic)
    writes.push(() => ({ kind: 'routine', routine: write() }))
  }
  yield* requireTopics(topics, topicIds)
  return yield* plans.prepared(id, topics, writes)
})

/** A failed preparation stays reviewable and retryable, without approving any of its primitives. */
export const retryWorkspacePlan = Effect.fn('workspacePlans.prepareAgain')(function* (id: string, revision: number) {
  yield* requireResident
  const plans = yield* WorkspacePlans
  const current = yield* plans.get(id)
  if (current.revision !== revision) return yield* new Conflict({ reason: 'workspace_plan_revision' })
  return yield* SingleFlight.use((flight) =>
    flight.run(
      `workspace-plan:prepare:${id}`,
      prepareWorkspacePlan(id).pipe(
        // expected: preparation can wait for a connection or grant; keep its review card available for recovery.
        Effect.catch((error) =>
          Effect.flatMap(plans.get(id), (latest) => plans.save({ ...latest, problem: outcomeOf(error) })),
        ),
      ),
    ),
  )
})

/** Chat may prepare a composition, but only the owner API can activate it. */
export const proposeWorkspacePlan = (proposal: WorkspacePlanProposal, chat: string, operationId: string) =>
  Effect.gen(function* () {
    yield* requireResident
    const id = `wsp_${(yield* attempt(() => sha256Hex(operationId))).slice(0, 32)}`
    // Check every caller's proposal before joining an in-flight preparation.
    yield* (yield* WorkspacePlans).begin(id, operationId, chat, proposal)
    return yield* retryWorkspacePlan(id, 1)
  })

const currentItem = Effect.fn('workspacePlans.currentItem')(function* (item: WorkspacePlanItem) {
  if (item.kind === 'source') {
    const current = (yield* Sources.use((sources) => sources.routes(item.source.id))).source
    if (current.revision !== item.source.revision || !['proposed', 'active'].includes(current.state))
      return yield* new Conflict({ reason: 'workspace_plan_source_changed' })
    return current.state
  }
  const current = yield* Routines.use((routines) => routines.view(item.routine.id))
  if (
    current.revision !== item.routine.revision ||
    !['proposed', 'activating', 'active', 'completed'].includes(current.state)
  )
    return yield* new Conflict({ reason: 'workspace_plan_routine_changed' })
  return current.state
})

const applyItem = Effect.fn('workspacePlans.applyItem')(function* (id: string, index: number, item: WorkspacePlanItem) {
  yield* requireResident
  const state = yield* currentItem(item)
  if (item.kind === 'source') {
    if (state !== 'active') yield* Sources.use((sources) => sources.confirm(item.source.id, item.source.revision))
  } else if (state !== 'active' && state !== 'completed') {
    yield* routineChange(
      item.routine.id,
      { revision: item.routine.revision, operationId: `${id}:confirm:${String(index)}` },
      'confirm',
    )
  }
})

const topicIdsOf = (item: WorkspacePlanItem): readonly number[] => {
  if (item.kind === 'routine') return [item.routine.topic]
  return 'topic' in item.source.setup.newKeys ? [item.source.setup.newKeys.topic] : []
}

const requireTopics = Effect.fn('workspacePlans.requireTopics')(function* (
  topics: readonly TopicView[],
  ids: readonly number[],
) {
  for (const topic of topics.filter(({ id }) => ids.includes(id))) {
    if ((yield* Topics.use((registry) => registry.get(topic.id))).revision !== topic.revision)
      return yield* new Conflict({ reason: 'workspace_plan_topic_changed' })
  }
})

/** Resume a partial approval, fencing each exact Source/Routine revision. */
const apply = (id: string, revision: number) =>
  Effect.gen(function* () {
    yield* requireResident
    const plans = yield* WorkspacePlans
    let plan = yield* plans.get(id)
    if (plan.revision !== revision) return yield* new Conflict({ reason: 'workspace_plan_revision' })
    if (plan.state === 'preparing') return yield* new Conflict({ reason: 'workspace_plan_not_ready' })
    if (plan.state === 'ready') return plan
    const pending = plan.items.filter((_, index) => !plan.completed.includes(index))
    for (const item of pending) {
      yield* requireTopics(plan.topics, topicIdsOf(item))
      yield* currentItem(item)
    }
    plan = yield* plans.save({ ...plan, state: 'applying', problem: null })
    for (const [index, item] of plan.items.entries()) {
      if (plan.completed.includes(index)) continue
      const topics = topicIdsOf(item)
      yield* requireTopics(plan.topics, topics)
      yield* applyItem(id, index, item)
      plan = yield* plans.save({ ...plan, completed: [...plan.completed, index] })
    }
    return yield* plans.save({ ...plan, state: 'ready' })
  })

/** One application at a time across waits; completed primitives remain recorded when a later one fails. */
export const applyWorkspacePlan = Effect.fn('workspacePlans.apply')(function* (id: string, revision: number) {
  yield* requireResident
  const current = yield* WorkspacePlans.use((plans) => plans.get(id))
  if (current.revision !== revision) return yield* new Conflict({ reason: 'workspace_plan_revision' })
  return yield* SingleFlight.use((flight) =>
    flight.run(
      `workspace-plan:apply:${id}`,
      apply(id, revision).pipe(
        Effect.flatMap(continueWorkspacePlan),
        Effect.tapError((error) =>
          WorkspacePlans.use((plans) =>
            Effect.flatMap(plans.get(id), (plan) =>
              plan.state === 'applying'
                ? plans.save({ ...plan, state: 'attention', problem: outcomeOf(error) })
                : Effect.void,
            ),
          ),
        ),
      ),
    ),
  )
})
