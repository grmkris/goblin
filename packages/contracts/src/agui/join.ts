import * as Schema from 'effect/Schema'

// How a reader reaches a chat's stream (docs/architecture/streams.md). Effect only, so the API contract can name it
// without AG-UI's runtime.

/**
 * Who reads what of a chat's stream: `full` carries everything (reasoning, tool calls, steps, the whole STATE
 * document); `answers` carries the run lifecycle, the messages people and agents wrote, activities, subagent lifecycle
 * and `/attention`.
 */
export const StreamTier = Schema.Literals(['full', 'answers'])
export type StreamTier = typeof StreamTier.Type

/**
 * `GET /api/conversations/:id/stream`: where to read the chat's stream (docs/architecture/streams.md). `url` carries a
 * signed token valid until `expiresAt` (ISO 8601, ten minutes), for epoch `epoch` of the chat's stream in `tier`;
 * a reader asks again after `goblin.stream.moved`, or once the URL expired.
 */
export const ConversationStream = Schema.Struct({
  url: Schema.String,
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
  tier: StreamTier,
  expiresAt: Schema.String,
})
export type ConversationStream = typeof ConversationStream.Type
