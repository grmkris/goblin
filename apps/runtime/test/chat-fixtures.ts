import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget, type ModelBudget } from '../src/budget.ts'
import { attempt, attemptSync } from '../src/http/errors.ts'
import { makeChatOperations } from '../src/chats/operations.ts'
import { PERSONAL_TOPIC } from '@goblin/contracts'
import { primaryChat } from '../src/chats/directory.ts'
import { ChatOperations, Conversations } from '../src/chats/service.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { AppEngine } from '../src/agent-apps/service.ts'
import { Receipts } from '../src/organize/service.ts'
import { Skills } from '../src/skills/service.ts'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import { Setups } from '../src/setup/service.ts'
import { Topics } from '../src/topics/service.ts'
import { ChatsLive } from '../src/layers/conversation.ts'
import { Models, type ModelPicker } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'

/** A probe's own instances, which the Telegram ports' programs read (channel/turns.ts). */
type PortInstances = {
  readonly db: Db['Service']
  readonly harness: PiHarness
  readonly budget: ModelBudget
  readonly models: ModelPicker
  /** Where flows go: nowhere unless a probe records them. */
  readonly flows?: Layer.Layer<FlowEvents>
}

/**
 * The services the Telegram ports' programs read, over a probe's own instances: the chat directory and admission over
 * its database (each chat's lock in `KeyedLock`), its budget and model picker as their services wrap them, and Pi as
 * its sessions. Flows go to `flows`, else nowhere.
 */
export const portServices = ({ db, harness, budget, models, flows = FlowEvents.noop }: PortInstances) => {
  // SAFETY: admission reads only Pi's harness and the models it applied from the instance input; no routine answers.
  const input = Layer.succeed(AgentInput, { harness, applied: new Map() } as AgentInputs)
  const plans = Layer.mergeAll(
    Layer.succeed(
      Budget,
      Budget.of({
        today: (now) => attempt(() => budget.today(now)),
        record: (use, now, model) => Effect.sync(() => budget.record(use, now, model)),
        require: (now) => attempt(() => budget.require(now)),
        open: (now) => attempt(() => budget.require(now)),
        admit: (now) => attempt(() => budget.require(now)),
      }),
    ),
    Layer.succeed(
      Models,
      Models.of({
        current: Effect.sync(() => models.current()),
        choice: Effect.sync(() => models.choice()),
        choose: (modelId, now) => attemptSync(() => models.choose(modelId, now)),
      }),
    ),
  )
  const pi = PiSessions.layer.pipe(Layer.provide(input))
  const core = Layer.mergeAll(Layer.succeed(Db, db), KeyedLock.layer, pi, flows, plans, input)
  const operations = Layer.effect(ChatOperations, makeChatOperations)
  // A probe's routes all go to Personal, main, and no Persona answers there.
  const topics = Layer.mergeAll(
    Layer.mock(Conversations, {
      routineHome: (topic: number) =>
        Effect.succeed({ chat: primaryChat, topic: topic === PERSONAL_TOPIC ? topic : PERSONAL_TOPIC }),
    }),
    Layer.mock(Personas, { active: Effect.succeed([]) }),
    Layer.mock(Invocations, {}),
    // No probe makes a Topic for a new chat.
    Layer.mock(Topics, {}),
    Layer.mock(Receipts, {}),
    Layer.mock(Setups, {}),
    Layer.mock(AppEngine, {}),
    Layer.mock(Skills, {}),
    Layer.mock(McpConnections, {}),
    Layer.mock(McpServers, {}),
    Layer.mock(McpGrants, {}),
  )
  return Layer.mergeAll(
    ChatsLive.pipe(Layer.provide(Layer.succeed(Db, db))),
    operations.pipe(Layer.provide(core)),
    plans,
    pi,
    topics,
    input,
    flows,
  )
}
