import type { ModelEndpointView, OnboardingKickoff, OnboardingStep, OnboardingView } from '@goblin/contracts'
import { ONBOARDING_STEPS, type OnboardingChange, type OnboardingConnect } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { sendOwnerMessage } from '../agent-program.ts'
import { Chats } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { InvalidInput } from '../http/errors.ts'
import { Inference } from '../inference/service.ts'
import { McpServers } from '../mcp/service.ts'
import { createTopic } from '../topics/program.ts'
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
    goblin: record?.kickoff !== undefined || went('goblin'),
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
    kickoff: record?.kickoff !== undefined,
  }
  return view
})

/** The owner finishes, skips or reopens Start, or goes through a step; answered with the view. */
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

/** How long the kickoff channel receives the reminder to begin useful work (seconds). */
const KICKOFF_WINDOW = 20 * 60

const KICKOFF_ASK =
  'The owner just described what they want help with. Begin by doing one useful piece of that work in the current channel. Ask one focused question only if it is needed to make progress. Offer a channel name, Persona, or routine later when the work makes one useful; do not begin with an architecture questionnaire.'

/**
 * What goblin's context block says about setup, in the kickoff channel only: right after the kickoff, begin useful
 * work and introduce structure when needed. Read from the agent's own record, so it costs no call to any server.
 */
export const onboardingContext = (session: string) =>
  Effect.gen(function* () {
    const kickoff = (yield* Onboarding.use((onboarding) => onboarding.read))?.kickoff
    if (kickoff === undefined || (yield* epochSeconds) - kickoff.at >= KICKOFF_WINDOW) return undefined
    const chats = yield* Chats
    return (yield* chats.session(kickoff.chat)) === session ? KICKOFF_ASK : undefined
  })

/**
 * Start's kickoff (ADR 0079), whole: a channel named `channel` with the goal as its description, the kickoff recorded
 * into it, the goal sent there as the owner's first message, and Start done. Each piece runs under an operation id made
 * from the kickoff's, so a retry replays what an earlier attempt made and goes on from there. The only refusals (no
 * goal, a taken name) come before anything is made.
 */
export const kickoff = ({ goal, channel, operationId }: OnboardingKickoff) =>
  Effect.gen(function* () {
    const text = goal.trim()
    if (text === '') return yield* new InvalidInput({ reason: 'empty_message' })
    const topic = yield* createTopic(
      { name: channel, description: text.slice(0, 1000), operationId: `${operationId}:channel` },
      'owner',
    )
    // Recorded before the message goes, so the first model request in the channel already sees the reminder.
    const now = yield* epochSeconds
    yield* Onboarding.use((onboarding) => onboarding.kickoff(topic.conversation, now))
    yield* sendOwnerMessage(topic.conversation, { text, operationId: `${operationId}:message` })
    const view = yield* changeOnboarding({ status: 'done', step: 'goblin' })
    return { topic, view }
  })
