import * as Schema from 'effect/Schema'
import { ModelEndpointView } from './agent.ts'
import { ChatId } from './ids.ts'

/**
 * First-run Start (ADR 0062): `done` or `skipped` once the owner said so, `open` until then. Start never stands before
 * the app, whatever its status.
 */
export const OnboardingStatus = Schema.Literals(['open', 'done', 'skipped'])
export type OnboardingStatus = typeof OnboardingStatus.Type

/**
 * Start's steps, in order: what goblin is, the model it uses (the deployment's, or the owner's own), the services it
 * reaches, and what goblin is for.
 */
export const ONBOARDING_STEPS = ['welcome', 'model', 'services', 'goblin'] as const
export const OnboardingStep = Schema.Literals(ONBOARDING_STEPS)
export type OnboardingStep = typeof OnboardingStep.Type

/** `GET /api/onboarding`: Start's whole state, from what the owner did and what the agent already knows. */
export const OnboardingView = Schema.Struct({
  status: OnboardingStatus,
  steps: Schema.Array(Schema.Struct({ id: OnboardingStep, done: Schema.Boolean })),
  /** Where the agent's model calls go now (ADR 0059). */
  model: ModelEndpointView,
  /** Connected servers. */
  connected: Schema.Number,
  kickoff: Schema.Boolean,
})
export type OnboardingView = typeof OnboardingView.Type

/**
 * `PUT /api/onboarding`: finish or skip Start (`open` forgets that), mark a step the owner went through, or record the
 * kickoff. Only `status` changes the status: going through a step leaves it as it was.
 */
export const OnboardingChange = Schema.Struct({
  status: Schema.optional(OnboardingStatus),
  step: Schema.optional(OnboardingStep),
  kickoff: Schema.optional(Schema.Literal(true)),
  /** The channel that receives the first useful-work message and its temporary guidance. */
  kickoffChat: Schema.optional(ChatId),
})
export type OnboardingChange = typeof OnboardingChange.Type

/**
 * `POST /api/onboarding/connect`: Start signs the owner in to `connectionId` and brings them back to `step`. Nothing is
 * allowed on the way: the step offers the server's suggested access.
 */
export const OnboardingConnect = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  step: OnboardingStep,
})
export type OnboardingConnect = typeof OnboardingConnect.Type
