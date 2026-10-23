import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
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
import { ModelBudgetLive } from '../src/layers/budget.ts'
import { ChatsLive } from '../src/layers/conversation.ts'
import { Cipher, CredentialCipher } from '../src/mcp/oauth/cipher.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { fake } from './fake.ts'
import type { RuntimeEnv } from '../src/env.ts'

/** A probe's own instances, which the Source ports' programs read (sources/turns.ts). */
type PortInstances = {
  readonly db: Db['Service']
  readonly harness: PiHarness
  /** Where flows go: nowhere unless a probe records them. */
  readonly flows?: Layer.Layer<FlowEvents>
}

/** The deployment's model settings a probe runs with: one model, `storage-only`, and a daily cap of 300,000 tokens. */
const PROBE_MODEL = {
  MODEL_ID: 'storage-only',
  MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
  MODEL_KEY: 'unused',
  DAILY_TOKEN_CAP: '300000',
}

/**
 * The services the Source ports' programs read, over a probe's own instances: the chat directory and admission over
 * its database (each chat's lock in `KeyedLock`), the budget and model picker as the agent builds them over it
 * (`ModelBudgetLive`, with the probe's model settings), and Pi as its sessions. Flows go to `flows`, else nowhere.
 */
export const portServices = ({ db, harness, flows = FlowEvents.noop }: PortInstances) => {
  // Admission reads only Pi's harness, the models it applied and the tool filters from the instance input, and the model
  // layers only the deployment's model settings and the owner; no probe sets an owner endpoint, and no routine answers.
  const input = Layer.succeed(
    AgentInput,
    fake<AgentInputs>({
      harness,
      applied: new Map(),
      toolSets: { subagents: [], all: [] },
      retooled: new Map(),
      env: fake<RuntimeEnv>(PROBE_MODEL),
      workspaceId: 'probe-owner',
    }),
  )
  const cipher = Layer.effect(
    Cipher,
    Effect.promise(() => CredentialCipher.fromBase64(btoa('\0'.repeat(32)))),
  )
  const plans = ModelBudgetLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Db, db), input, cipher)))
  const pi = PiSessions.layer.pipe(Layer.provide(input))
  const core = Layer.mergeAll(Layer.succeed(Db, db), KeyedLock.layer, pi, flows, plans, input)
  const operations = Layer.effect(ChatOperations, makeChatOperations)
  // A probe's routes all go to Personal, main, and no Persona answers there.
  const topics = Layer.mergeAll(
    Layer.mock(Conversations, {
      routineHome: (topic: number) =>
        Effect.succeed({ chat: primaryChat, topic: topic === PERSONAL_TOPIC ? topic : PERSONAL_TOPIC }),
    }),
    Layer.mock(Personas, { active: Effect.succeed([]), ownerOnly: () => false }),
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
    Layer.succeed(Db, db),
  )
}
