import * as Schema from 'effect/Schema'
import { ComposerOption } from '../composer.ts'
import { QuestionSpec } from '../conversations.ts'
import { Attachment } from '../files.ts'
import { ChatId, EntryId, PersonaId } from '../ids.ts'
import { SubmissionId } from '../queue.ts'

/**
 * An input waiting in the chat's queue for its next boundary: steered into the run, or a follow-up after it, with its
 * words and what came with them as a user message carries them (who wrote it when not the owner's composer, its
 * files, its composer choices and what an open App shared), once the producer read them.
 */
export const QueueItem = Schema.Struct({
  id: SubmissionId,
  mode: Schema.Literals(['steer', 'followUp']),
  text: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  selections: Schema.optionalKey(Schema.Array(ComposerOption)),
  context: Schema.optionalKey(Schema.Array(Schema.Struct({ from: Schema.String, text: Schema.String }))),
})
export type QueueItem = typeof QueueItem.Type

/** A wait before the next attempt: when it ends (epoch ms) and the error that caused it. */
const Backoff = Schema.Struct({ at: Schema.Number, error: Schema.String })

/**
 * The model call in flight: its attempt, the backoff before a retry, or the poll of a deferred response; null when no
 * call is in flight.
 */
export const GenerationState = Schema.NullOr(
  Schema.Struct({
    attempt: Schema.Int,
    retry: Schema.optionalKey(Backoff),
    deferred: Schema.optionalKey(Schema.Struct({ pollAt: Schema.Number })),
  }),
)
export type GenerationState = typeof GenerationState.Type

const CompactionReason = Schema.Literals(['manual', 'threshold', 'overflow'])

/**
 * Compactions of the chat's context: the ones running (`blocking` when the next model call waits for one), and the
 * newest failure since a compaction last produced a summary.
 */
export const CompactionsState = Schema.Struct({
  running: Schema.Array(
    Schema.Struct({
      reason: CompactionReason,
      blocking: Schema.Boolean,
      attempt: Schema.optionalKey(Schema.Int),
      retry: Schema.optionalKey(Backoff),
    }),
  ),
  failure: Schema.NullOr(Schema.Struct({ reason: CompactionReason, error: Schema.String })),
})
export type CompactionsState = typeof CompactionsState.Type

/** The model the chat answers with and its thinking level, when set. */
export const AgentView = Schema.Struct({
  model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
  thinkingLevel: Schema.optionalKey(Schema.String),
})
export type AgentView = typeof AgentView.Type

/** Tokens, as Pi counts them: `input` without the cache reads and writes, `totalTokens` with them. */
export const TokenCounts = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  reasoning: Schema.optionalKey(Schema.Number),
})
export type TokenCounts = typeof TokenCounts.Type

/** The chat's own spend so far: model calls by `provider/modelId`, tool executions by tool name. */
export const UsageView = Schema.Struct({
  models: Schema.Record(Schema.String, TokenCounts),
  tools: Schema.Record(Schema.String, TokenCounts),
})
export type UsageView = typeof UsageView.Type

/**
 * Why something waits for a person, by goblin's own markers only: `ask_user`'s questions, an ask-first call to approve
 * (`approval`), a tool to allow (`grant`), a URL request to finish (`url`), a sign-in with more access (`access`) or
 * to a connection (`connect`), and something the Topic's setup does not hold (`setup`).
 */
export const AttentionReason = Schema.Literals(['question', 'approval', 'grant', 'url', 'access', 'connect', 'setup'])
export type AttentionReason = typeof AttentionReason.Type

/**
 * What an attention item is about: the entry that raised it, a question's specs, the held call's or URL request's id,
 * the connection and tool, the scope asked for, and for a Persona's hold its Persona and its own chat (`fork`).
 */
export const AttentionDetail = Schema.Struct({
  entryId: EntryId,
  questions: Schema.optionalKey(Schema.Array(QuestionSpec)),
  approvalId: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  connectionId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(PersonaId),
  fork: Schema.optionalKey(ChatId),
})
export type AttentionDetail = typeof AttentionDetail.Type

/**
 * Something in the chat that waits for a person: an AG-UI `Interrupt` (it is what a run finished with the `interrupt`
 * outcome carries). The answer is the owner's next ordinary message, or the app's own control for an approval, a
 * grant, a URL request or a sign-in; `id` is stable for as long as the item stays open.
 */
export const AttentionItem = Schema.Struct({
  id: Schema.String,
  reason: AttentionReason,
  message: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  metadata: Schema.Struct({ goblin: AttentionDetail }),
})
export type AttentionItem = typeof AttentionItem.Type

/**
 * A chat's STATE document (`STATE_SNAPSHOT`, then RFC 6902 `STATE_DELTA`s that replace one top-level member at a
 * time). Every member is always present. `/attention` is the only member the `answers` tier carries.
 */
export const GoblinState = Schema.Struct({
  queue: Schema.Array(QueueItem),
  generation: GenerationState,
  compactions: CompactionsState,
  agent: AgentView,
  usage: UsageView,
  attention: Schema.Array(AttentionItem),
})
export type GoblinState = typeof GoblinState.Type

/** The STATE members the `answers` tier carries. */
export const ANSWERS_STATE: readonly (keyof GoblinState)[] = ['attention']
