import * as Schema from 'effect/Schema'

/**
 * Resident authority (ADR 0088): `never` before the owner's first signed-in action, then `active` until they revoke it.
 * `grantedAt` is when it was first granted, `revokedAt` when it was revoked; epoch seconds.
 */
export const ResidentStatus = Schema.Struct({
  state: Schema.Literals(['active', 'revoked', 'never']),
  grantedAt: Schema.optional(Schema.Number),
  revokedAt: Schema.optional(Schema.Number),
})
export type ResidentStatus = typeof ResidentStatus.Type

/**
 * The tokens the workspace's agent spent on models today (UTC), the deployment's daily cap (null: none), and when the day
 * resets (epoch seconds).
 */
export const UsageToday = Schema.Struct({
  used: Schema.Number,
  limit: Schema.NullOr(Schema.Number),
  resetsAt: Schema.Number,
})
export type UsageToday = typeof UsageToday.Type

/** Main's memory: the messages it remembers, and how many of them its newest view summarizes. */
export const MemoryStatus = Schema.Struct({ messages: Schema.Number, summarized: Schema.Number })
export type MemoryStatus = typeof MemoryStatus.Type

/** A model the deployment offers. `route` groups models by provider route, because quotas are per route. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  route: Schema.String,
  note: Schema.String,
  images: Schema.Boolean,
  /** The context the agent may fill, in tokens; Pi compacts the conversation before it is full. */
  contextWindow: Schema.Number,
})
export type ModelOption = typeof ModelOption.Type

/**
 * The model the workspace's agent answers with, the endpoint's default, and every model on offer (default first). With no
 * model endpoint (ADR 0064) nothing is on offer: `options` is empty and there is no `current` or `default`.
 */
export const ModelChoice = Schema.Struct({
  current: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
  options: Schema.Array(ModelOption),
})
export type ModelChoice = typeof ModelChoice.Type

/**
 * The models a Persona may name now (`GET /api/models`): those the owner's model endpoint in use offers, its default
 * first. A Persona's `model` outside this list is refused when written and ignored when it answers.
 */
export const ModelOffer = Schema.Struct({ default: Schema.optional(Schema.String), models: Schema.Array(ModelOption) })
export type ModelOffer = typeof ModelOffer.Type

/**
 * Where the agent's model calls go (ADR 0059): the deployment's endpoint, or the owner's own OpenAI-compatible one,
 * shown by its base URL and the last characters of its key, never the key. `models` are the ones it serves, its
 * default first. `none` (ADR 0064): the deployment has no endpoint of its own and the owner has not set theirs, so no
 * model call can be made. `deployment` says whether the deployment has one, which clearing the owner's goes back to.
 */
export const ModelEndpointView = Schema.Struct({
  source: Schema.Literals(['owner', 'deployment', 'none']),
  deployment: Schema.Boolean,
  baseUrl: Schema.optional(Schema.String),
  keyHint: Schema.optional(Schema.String),
  models: Schema.Array(Schema.String),
})
export type ModelEndpointView = typeof ModelEndpointView.Type

/** The owner's own endpoint: an OpenAI-compatible base URL (`https://…/v1`) and its key. */
export const ModelEndpointInput = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
})
export type ModelEndpointInput = typeof ModelEndpointInput.Type

/** A user or assistant message; `author` names who wrote a user message when it was not the owner's browser. */
export const TranscriptMessage = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
  author: Schema.optionalKey(Schema.String),
})
export type TranscriptMessage = typeof TranscriptMessage.Type

/**
 * `POST /api/agent/ask`: a question for the agent in main, labelled with the caller's name (ADR 0086), and how long to
 * wait for the answer before answering `running`.
 */
export const AgentAsk = Schema.Struct({
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  waitMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 110_000 })),
})
export type AgentAsk = typeof AgentAsk.Type

/** The answer, or `running` with the operation id to wait again, or why the turn ended without one. */
export const AskResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('done'), operationId: Schema.String, text: Schema.String }),
  Schema.Struct({ status: Schema.Literal('running'), operationId: Schema.String }),
  Schema.Struct({ status: Schema.Literal('unanswered'), operationId: Schema.String, reason: Schema.String }),
])
export type AskResult = typeof AskResult.Type
