import * as Schema from 'effect/Schema'
import { QuestionSpec } from './conversations.ts'
import { EntryId, OperationId, PersonaId } from './ids.ts'
import { PersonaHold, PersonaInvocationView } from './personas.ts'

/**
 * One entry of a chat as a server reads it (ADR 0081), normalized from Pi's records: tool traffic and bookkeeping are
 * left out.
 *
 * - `message`: the owner's or the agent's words. `final` says the agent's turn ended there rather than in a tool call;
 *   an owner message names its author when it came from someone other than the owner's own composer.
 * - `persona`: a Persona's attributed answer at the revision it answered with, and what it stopped on when it needs the
 *   owner (ADR 0041).
 * - `question`: what `ask_user` asked; the turn ended there and the next message answers it.
 */
export const ConversationEntryView = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('message'),
    id: EntryId,
    role: Schema.Literals(['owner', 'agent']),
    text: Schema.String,
    author: Schema.optional(Schema.String),
    final: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal('persona'),
    id: EntryId,
    persona: Schema.Struct({ id: PersonaId, name: Schema.String, revision: Schema.Int }),
    operationId: OperationId,
    text: Schema.String,
    hold: Schema.optional(Schema.Struct({ kind: PersonaHold.fields.kind, name: Schema.String })),
  }),
  Schema.Struct({ kind: Schema.Literal('question'), id: EntryId, questions: Schema.Array(QuestionSpec) }),
])
export type ConversationEntryView = typeof ConversationEntryView.Type

/**
 * `GET /api/conversations/:id/entries?after=&limit=`: a chat's entries after entry `after`, oldest first. `next` is
 * the cursor to read from next (the last entry looked at, which may be one left out); `more` says entries remain past
 * it. `activity` says whether the chat is working now, and `invocations` are its newest Persona invocations, so a
 * Persona that failed or was stopped, and wrote no answer, is still seen.
 */
export const ConversationEntries = Schema.Struct({
  entries: Schema.Array(ConversationEntryView),
  next: Schema.Int,
  more: Schema.Boolean,
  activity: Schema.Literals(['working', 'idle']),
  invocations: Schema.Array(PersonaInvocationView),
})
export type ConversationEntries = typeof ConversationEntries.Type
