import * as Schema from 'effect/Schema'
import { ComposerOption } from '../composer.ts'
import { Attachment } from '../files.ts'
import { ChatId, EntryId, OperationId, PersonaId } from '../ids.ts'
import { McpOutcome } from '../mcp.ts'
import { PersonaAskData, PersonaAvatar, PersonaHold } from '../personas.ts'
import { QuestionSpec } from '../conversations.ts'
import { TokenCounts } from './state.ts'

/**
 * A Persona's attributed answer (ADR 0033) on its assistant message: who answered at which revision, for which
 * operation, the routine run that handed it the work, and what it stopped on or asked when it needs the owner.
 */
export const PersonaMark = Schema.Struct({
  id: PersonaId,
  name: Schema.String,
  revision: Schema.Int,
  avatar: PersonaAvatar,
  operationId: OperationId,
  routine: Schema.optionalKey(Schema.Struct({ id: Schema.String, run: Schema.String })),
  hold: Schema.optionalKey(PersonaHold),
  questions: Schema.optionalKey(Schema.Array(QuestionSpec)),
})
export type PersonaMark = typeof PersonaMark.Type

/**
 * Why an assistant message has no whole answer: the model call failed (`error`, with the provider's first line), was
 * stopped (`aborted`), or reached the output limit (`length`).
 */
export const StopMark = Schema.Struct({
  reason: Schema.Literals(['error', 'aborted', 'length']),
  message: Schema.optionalKey(Schema.String),
})
export type StopMark = typeof StopMark.Type

/**
 * `metadata.goblin` on an event or a message: what goblin knows beyond AG-UI's fields. Every field is optional and
 * present only where it applies.
 *
 * - `entryId`: the Pi entry a committed message is (on `TEXT_MESSAGE_END`, `TOOL_CALL_RESULT`, `ACTIVITY_SNAPSHOT` and
 *   every snapshot message), so a reader can page history before it.
 * - `at`: when the message was written (epoch milliseconds), on a message's first event and in snapshots.
 * - A user message: `author` (who wrote it when not the owner's own composer: a Source, a server's key, an MCP client,
 *   a subagent, `Routine`), `member` (a member of a workspace of several people, ADR 0094), `own` (the owner's own turn
 *   that came from elsewhere, ADR 0066), `attachments`, `context` (what an open App shared, untrusted), `selections`
 *   (the composer's `@`/`/` choices), `outcome` (how a held call ended) and `kept` (an outcome kept for the next turn),
 *   `thread` (the thread a shared note or a routine report came from) and `ask` (the Personas it went to instead of
 *   the agent, ADR 0090).
 * - An assistant message: `persona` (a Persona's answer), `stop` (why it has no whole answer) and `usage` (the tokens
 *   its model call used, as Pi counts them).
 * - `branchable`: a Thread may start at the message's entry (ADR 0034): the owner's own words and the agent's answers.
 * - `omits`: the entries a later entry leaves out of the chat (a turn moved to a Thread, ADR 0034), on that entry's
 *   message: a reader hides the messages of those entries, wherever it read them.
 * - `MESSAGES_SNAPSHOT`: `before`, the entry older history is read before, a page at a time (the history endpoint);
 *   absent when the snapshot starts at the chat's beginning.
 * - `RUN_STARTED`: `operations`, the operation ids of the inputs that started it, when the stream saw them admitted.
 * - A tool call or result: `details` (Pi's details for UIs), `isError`, `parentToolCallId` (a nested call's caller);
 *   a result names its tool (`toolName`), for a reader that does not hold the call.
 */
export const GoblinMetadata = Schema.Struct({
  entryId: Schema.optionalKey(EntryId),
  at: Schema.optionalKey(Schema.Number),
  author: Schema.optionalKey(Schema.String),
  member: Schema.optionalKey(Schema.Struct({ name: Schema.String, userId: Schema.String })),
  own: Schema.optionalKey(Schema.Literal(true)),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  context: Schema.optionalKey(Schema.Array(Schema.Struct({ from: Schema.String, text: Schema.String }))),
  selections: Schema.optionalKey(Schema.Array(ComposerOption)),
  outcome: Schema.optionalKey(McpOutcome),
  kept: Schema.optionalKey(Schema.Literal(true)),
  thread: Schema.optionalKey(ChatId),
  ask: Schema.optionalKey(PersonaAskData),
  persona: Schema.optionalKey(PersonaMark),
  stop: Schema.optionalKey(StopMark),
  usage: Schema.optionalKey(TokenCounts),
  branchable: Schema.optionalKey(Schema.Literal(true)),
  omits: Schema.optionalKey(Schema.Array(EntryId)),
  before: Schema.optionalKey(EntryId),
  operations: Schema.optionalKey(Schema.Array(OperationId)),
  details: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
  toolName: Schema.optionalKey(Schema.String),
  parentToolCallId: Schema.optionalKey(Schema.String),
})
export type GoblinMetadata = typeof GoblinMetadata.Type

/** An event's or a message's `metadata` as goblin writes it: its fields under `goblin`, AG-UI's key left alone. */
export const GoblinMetadataOf = Schema.Struct({ goblin: GoblinMetadata })
export type GoblinMetadataOf = typeof GoblinMetadataOf.Type
