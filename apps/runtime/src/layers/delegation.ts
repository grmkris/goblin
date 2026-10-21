import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Conversations } from '../chats/service.ts'
import { offeredModels } from '../inference/store.ts'
import { Memories } from '../memory/service.ts'
import { madeByKey } from '../keys/reach.ts'
import { deploymentModelIds, ownerModelIds } from '../models.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { OrganizeReceipts } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import { PersonaInvocations } from '../personas/invocations.ts'
import { PersonaRegistry } from '../personas/registry.ts'
import { Invocations, Personas, type ServerFence } from '../personas/service.ts'
import { restoreHelperExecution } from '../pi/helper-execution.ts'
import type { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { routeRevision } from '../sources/store.ts'
import { AgentInput } from '../runtime/input.ts'
import { topicPorts } from '../topics/ports.ts'
import { TopicRegistry } from '../topics/registry.ts'
import { Topics } from '../topics/service.ts'

/** The delegation stores, one each per agent: Topics, Personas, the invocations and receipts, on SQLite. */
export type DelegationStores = {
  readonly topics: TopicRegistry
  readonly personas: PersonaRegistry
  readonly fence: ServerFence
  readonly invocations: PersonaInvocations
  readonly receipts: OrganizeReceipts
}

/**
 * The delegation services over `stores`: Topics (creates serialized by the per-key lock), Personas, the invocations
 * and receipts, each telling the change bus what its writes changed.
 */
export const delegationServices = (
  stores: DelegationStores,
): Layer.Layer<Topics | Personas | Invocations | Receipts, never, KeyedLock | Changes> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const topics = yield* Topics.make(stores.topics)
      const personas = yield* Personas.make(stores.personas, stores.fence)
      const receipts = yield* Receipts.make(stores.receipts)
      const invocations = yield* Invocations.make(stores.invocations)
      return Context.mergeAll(
        Topics.context(topics),
        Personas.context(personas),
        Invocations.context(invocations),
        Receipts.context(receipts),
      )
    }),
  )

/**
 * The agent's own delegation stores, each made here once: Topics, Personas, the invocations and receipts. A
 * Topic's Conversation is made, written and told about through the conversation services, listed with Personal's
 * switches inside the Topic's own transaction, and its memory turned on through Memories.
 */
const stores: Effect.Effect<DelegationStores, never, AgentInput | Db | Conversations | Memories> = Effect.gen(
  function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const topics = new TopicRegistry(
      db,
      topicPorts(db, { conversations: yield* Conversations, memories: yield* Memories }),
    )
    const personas = new PersonaRegistry(db, offeredModels(db, deploymentModelIds(input.env, input.workspaceId)))
    const receipts = new OrganizeReceipts(db, (kind, target) => {
      if (kind === 'source.route') return routeRevision(db, target)
      try {
        return (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision
      } catch {
        // expected: a receipt whose target is gone is not undoable.
        return undefined
      }
    })
    const owned = new Set(ownerModelIds(input.env))
    const fence = {
      ownerOnly: (id: string) => owned.has(id),
      keyTopic: (topic: number) => madeByKey(db, 'topic', topic),
    }
    return { topics, personas, fence, invocations: new PersonaInvocations(db), receipts } satisfies DelegationStores
  },
)

/** Delegation, Topics, Personas and organizing. */
export const DelegationLive: Layer.Layer<
  Topics | Personas | Invocations | Receipts,
  never,
  AgentInput | Db | KeyedLock | Changes | Conversations | Memories
> = Layer.unwrap(Effect.map(stores, delegationServices))

/** Start step 4: each helper conversation runs with the execution extensions the agent has now. */
export const HelperExecutionLive: Layer.Layer<never, never, AgentInput | Db> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { harness, helperExtensions } = yield* AgentInput
    const db = yield* Db
    yield* Effect.promise(() => restoreHelperExecution(db, harness, helperExtensions))
  }),
)
