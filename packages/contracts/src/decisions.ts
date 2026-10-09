import * as Schema from 'effect/Schema'

/** Owner-only proposals; confirming affects an affordance, never the agent's authority or transcripts. */
export const DecisionAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal('highlight'), relayId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('thread-draft'), title: Schema.String }),
])
export type DecisionAction = typeof DecisionAction.Type
export const DecisionLabel = Schema.Struct({ label: Schema.Literals(['confirm', 'dismiss']) })
export type DecisionLabel = typeof DecisionLabel.Type
export const DecisionProposal = Schema.Struct({
  id: Schema.String,
  chatId: Schema.String,
  kind: Schema.Literals(['attention-triage', 'separate-work']),
  subject: Schema.String,
  payload: DecisionAction,
  state: Schema.Literals(['open', 'confirmed', 'dismissed', 'stale']),
  probability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  provider: Schema.Literals(['rules', 'cloudflare/clef']),
  createdAt: Schema.Number,
  decidedAt: Schema.optional(Schema.Number),
})
export type DecisionProposal = typeof DecisionProposal.Type
