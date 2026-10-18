import * as Layer from 'effect/Layer'
import { AgentHttp } from '../http/api/server.ts'
import { Inspection } from '../inspect/service.ts'
import type { AgentInputs } from '../runtime/input.ts'
import { AppRegistryLive, AppsLive } from './apps.ts'
import { ModelBudgetLive } from './budget.ts'
import { SetupsLive } from './setup.ts'
import { ConversationLive, PrimaryChatLive } from './conversation.ts'
import { CoreLive } from './core.ts'
import { DelegationLive, HelperExecutionLive } from './delegation.ts'
import { ActivateMemoriesLive, CheapModelsLive, KnowledgeLive } from './knowledge.ts'
import { McpEventsLive, McpHostLive } from './mcp.ts'
import { OnboardingLive } from './onboarding.ts'
import { RoutineRunsLive, RoutinesLive } from './routines.ts'
import { LearnerLive, SkillsLive } from './skills.ts'
import { SourcesLive } from './sources.ts'
import { WorkspaceLive } from '../workspace/live.ts'
import { WorkspacePlansLive } from './workspace-plans.ts'

/** `step`, built after and over everything `built` provides; the result provides both. */
const then =
  <A, E, R>(step: Layer.Layer<A, E, R>) =>
  <A0, E0, R0>(built: Layer.Layer<A0, E0, R0>) =>
    Layer.provideMerge(step, built)

/**
 * The agent's start: the core services (step 1, `layers/core.ts`), then each step in its one fixed order (the boot
 * contract). A step is a layer built after and over every step before it, so its await holds up the steps after it.
 *
 * 2. The MCP host. Awaits the credential cipher's key, which every stored credential and held call is sealed with;
 *    each server's endpoint binding is checked and the held calls a restart cut off are recovered before anything
 *    can connect or decide one.
 * 3. The cheap models, which the memories (8) and the skill learner (after the start) are built over.
 * 4. Helper execution. Awaits Pi: every registered helper goes on with the execution extensions the agent has now,
 *    also after the object was rebuilt.
 * 5. Routine runs. Awaits the usage projection's subscription to Pi's commits, made after a snapshot of each live
 *    run, so nothing after it can commit to Pi unseen.
 * 6. Main registered, before anything reads the chat directory for it.
 * 7. The App registry, which follows `conversations.changed` and `agent-apps.changed` from the first write on.
 * 8. Memories. Awaits every Topic Conversation without memory being given it (a fresh agent's Personal, registered
 *    at 6, or a Topic whose activation a crash cut short).
 * 9. Skills, over the host's connections.
 * 10. Events. Awaits the hook token, then registers the skills consumer (9) before any delivery
 *     can reach the engine.
 */
const start = (input: AgentInputs) =>
  CoreLive(input).pipe(
    then(McpHostLive), // 2
    then(CheapModelsLive), // 3
    then(HelperExecutionLive), // 4
    then(RoutineRunsLive), // 5
    then(PrimaryChatLive), // 6
    then(AppRegistryLive), // 7
    then(ActivateMemoriesLive), // 8
    then(SkillsLive), // 9
    then(McpEventsLive), // 10
  )

/**
 * Every service of one agent, built once per Durable Object (agent.ts): the start (above), the model budget and model
 * picker (a send's admission reads them), then each area's layer in turn, each built
 * after and over everything before it: the skill learner after the owner's files and the routines' notices it writes,
 * and the Sources after the routines' notices they post and the owner's files they keep attachments in (their Events
 * handler is registered there, before the agent runs anything).
 */
export const AgentLive = (input: AgentInputs) =>
  start(input).pipe(
    then(ModelBudgetLive),
    then(ConversationLive),
    then(SetupsLive),
    then(KnowledgeLive),
    then(DelegationLive),
    then(RoutinesLive),
    then(Inspection.layer),
    then(AppsLive),
    then(SourcesLive),
    then(LearnerLive),
    then(WorkspaceLive),
    then(WorkspacePlansLive),
    then(OnboardingLive),
    then(AgentHttp.layer),
  )

/** Every service a program may require, derived from the layers so no area edits a shared union. */
export type AgentServices = Layer.Success<ReturnType<typeof AgentLive>>
