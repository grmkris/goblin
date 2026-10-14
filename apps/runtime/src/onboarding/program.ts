import type { ModelEndpointView, OnboardingStep, OnboardingView } from '@goblin/contracts'
import { ONBOARDING_STEPS, type OnboardingChange, type OnboardingConnect } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Chats } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { Inference } from '../inference/service.ts'
import { McpServers } from '../mcp/service.ts'
import { Onboarding } from './service.ts'
import type { OnboardingRecord } from './store.ts'

// First-run Start (ADR 0062): a short tour the owner may skip, which never stands before the app. Its status and its
// steps are done only by what the owner did: went through a step, set their own model endpoint, or sent the kickoff.

/** Each step's state, in Start's order. */
const stepsOf = (record: OnboardingRecord | undefined, model: ModelEndpointView) => {
  const went = (step: OnboardingStep) => record?.steps.includes(step) === true
  const done: Record<OnboardingStep, boolean> = {
    welcome: went('welcome'),
    model: went('model') || model.source === 'owner',
    services: went('services'),
    goblin: record?.kickoffAt !== undefined || went('goblin'),
  }
  return ONBOARDING_STEPS.map((id) => ({ id, done: done[id] }))
}

/** Start's whole state: the owner's record, where model calls go, and how many servers are connected. */
export const onboardingView = Effect.gen(function* () {
  const record = yield* Onboarding.use((onboarding) => onboarding.read)
  const model = yield* Inference.use((inference) => inference.view)
  const servers = yield* McpServers.use((owner) => owner.list())
  const view: OnboardingView = {
    status: record?.status ?? 'open',
    steps: stepsOf(record, model),
    model,
    connected: servers.filter((server) => server.status === 'connected').length,
    kickoff: record?.kickoffAt !== undefined,
  }
  return view
})

/** The owner finishes, skips or reopens Start, goes through a step, or sends the kickoff; answered with the view. */
export const changeOnboarding = (change: OnboardingChange) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    yield* Onboarding.use((onboarding) => onboarding.change(change, now))
    return yield* onboardingView
  })

/**
 * The step a sign-in Start began comes back to, where the server's suggested access is offered; nothing is allowed on
 * the way. None for a sign-in Start did not begin, which comes back to Connections as before.
 */
export const connectedFromStart = (connectionId: string) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    return yield* Onboarding.use((onboarding) => onboarding.takeConnect(connectionId, now))
  })

/** Start signs the owner in to a server and notes where to bring them back; connected at once, the note is taken now. */
export const startConnect = ({ connectionId, step }: OnboardingConnect) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    yield* Onboarding.use((onboarding) => onboarding.noteConnect(connectionId, step, now))
    const started = yield* McpServers.use((servers) => servers.beginConnect(connectionId))
    if (started.authorizationUrl === undefined) yield* connectedFromStart(connectionId)
    return started
  })

/** How long after the kickoff goblin is reminded to propose Topics and Personas (seconds). */
const KICKOFF_WINDOW = 20 * 60

const KICKOFF_ASK =
  'The owner just finished setup and said in their first message what they want goblin for. If you have not yet, propose 2 to 4 Topics and at most 2 Personas that fit it, in one ask_user question (kind "multi", each option one Topic or Persona with a one-line why). Create only the ones they choose, with topic_create and persona_create.'

/**
 * What goblin's context block says about setup, in main only: right after the kickoff, the ask to propose Topics and
 * Personas; nothing otherwise. Read from the agent's own record, so it costs no call to any server.
 */
export const onboardingContext = (session: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    if ((yield* chats.session(chats.primary)) !== session) return undefined
    const now = yield* epochSeconds
    const record = yield* Onboarding.use((onboarding) => onboarding.read)
    const kickoff = record?.kickoffAt !== undefined && now - record.kickoffAt < KICKOFF_WINDOW
    return kickoff ? KICKOFF_ASK : undefined
  })
