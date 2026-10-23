import * as Schema from 'effect/Schema'
import { QuestionSpec, questionText } from './conversations.ts'
import { ChatId, EntryId, NonEmptyString, OperationId, PageCursor, PersonaId } from './ids.ts'
import { PersonaSetup, SetupSummary } from './setup.ts'

/** A Persona's name, as `@name` in the composer: a letter, then up to 31 letters, digits, spaces, `_` or `-`. */
export const PersonaName = Schema.String.check(Schema.isPattern(/^[A-Za-z][\w -]{0,31}$/u))

/** A small mark: one to four characters on a hue (0–359). */
export const PersonaAvatar = Schema.Struct({
  glyph: NonEmptyString(4),
  hue: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(359)),
})
export type PersonaAvatar = typeof PersonaAvatar.Type

/**
 * How hard a Persona's model thinks before it answers (ADR 0100), bounded by that model's own control (ADR 0083): a
 * Qwen thinking budget of 2,048, 8,192 or 16,384 tokens, or a reasoning effort. Without one it thinks at `medium`.
 */
export const PersonaThinking = Schema.Literals(['low', 'medium', 'high'])
export type PersonaThinking = typeof PersonaThinking.Type

/**
 * How a Persona's answers reach its setup's MCP tools (ADR 0102): `native`, each as a tool of its own
 * (`<server>__<tool>`, ADR 0101), or `gateway`, through `mcp_list` and `mcp_call` as before. Without one it is `gateway`.
 */
export const PersonaTools = Schema.Literals(['native', 'gateway'])
export type PersonaTools = typeof PersonaTools.Type

/**
 * A Persona's definition (ADR 0033): a global name, its role in a line, its instructions, an optional model from the
 * offered list and how hard it thinks (ADR 0100), and its setup: the MCP servers, skills and apps it adds to the setup
 * of the Topic it answers in (ADR 0040). A setup only chooses among the owner's grants; a Persona never gains one.
 */
export const PersonaDefinition = Schema.Struct({
  name: PersonaName,
  avatar: PersonaAvatar,
  role: Schema.String.check(Schema.isMaxLength(120)),
  instructions: Schema.String.check(Schema.isMaxLength(8000)),
  model: Schema.optional(NonEmptyString(128)),
  thinking: Schema.optional(PersonaThinking),
  tools: Schema.optional(PersonaTools),
  setup: PersonaSetup,
})
export type PersonaDefinition = typeof PersonaDefinition.Type

/**
 * A Persona a server's API key made (ADR 0115): `key` is the key's name, or its id while goblin has not learnt the name
 * yet (one made before names were kept, until the key's next request).
 */
const PersonaMaker = Schema.Struct({ key: Schema.String })

/**
 * A Persona at its current revision; `madeBy` says which key made it, when one did (ADR 0115). An archived one no
 * longer answers but keeps its history. Times in seconds.
 */
export const PersonaView = Schema.Struct({
  ...PersonaDefinition.fields,
  id: PersonaId,
  madeBy: Schema.optional(PersonaMaker),
  revision: Schema.Int,
  archivedAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type PersonaView = typeof PersonaView.Type

/**
 * A Persona in a list (`GET /api/personas`): who it is and which key made it (`madeBy`, for display, ADR 0115), its revision and
 * model, and its setup in a line; its instructions and full setup are what `GET /api/personas/:id` answers. `updatedAt`
 * is its last change, in seconds.
 */
export const PersonaSummary = Schema.Struct({
  id: PersonaId,
  name: Schema.String,
  role: Schema.String,
  avatar: PersonaAvatar,
  madeBy: Schema.optional(PersonaMaker),
  revision: Schema.Int,
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(PersonaThinking),
  tools: Schema.optional(PersonaTools),
  setup: SetupSummary,
  archivedAt: Schema.optional(Schema.Number),
  updatedAt: Schema.Number,
})
export type PersonaSummary = typeof PersonaSummary.Type

/** A page of Personas, newest change first; `next` asks for the page after it. */
export const PersonaPage = Schema.Struct({ personas: Schema.Array(PersonaSummary), next: Schema.optional(PageCursor) })
export type PersonaPage = typeof PersonaPage.Type

/** `POST /api/personas`: the same operation id finds the same Persona. Without a setup it adds nothing. */
export const CreatePersona = Schema.Struct({
  ...PersonaDefinition.fields,
  setup: Schema.optional(PersonaSetup),
  operationId: OperationId,
})
export type CreatePersona = typeof CreatePersona.Type

/**
 * `PATCH /api/personas/:id`: a new revision. `expectedRevision` must be the current one, so two edits never silently
 * overwrite each other. `model: null` clears the preference, `thinking: null` returns it to `medium` and `tools: null`
 * to `gateway`.
 */
export const UpdatePersona = Schema.Struct({
  name: Schema.optional(PersonaName),
  avatar: Schema.optional(PersonaAvatar),
  role: Schema.optional(PersonaDefinition.fields.role),
  instructions: Schema.optional(PersonaDefinition.fields.instructions),
  model: Schema.optional(Schema.NullOr(NonEmptyString(128))),
  thinking: Schema.optional(Schema.NullOr(PersonaThinking)),
  tools: Schema.optional(Schema.NullOr(PersonaTools)),
  setup: Schema.optional(PersonaSetup),
  archived: Schema.optional(Schema.Boolean),
  expectedRevision: Schema.Int,
})
export type UpdatePersona = typeof UpdatePersona.Type

/** One stored revision: what the Persona was, who changed it and when. Invocations keep the revision they used. */
export const PersonaRevisionView = Schema.Struct({
  ...PersonaDefinition.fields,
  revision: Schema.Int,
  actor: Schema.Literals(['owner', 'agent']),
  createdAt: Schema.Number,
})
export type PersonaRevisionView = typeof PersonaRevisionView.Type

/**
 * `GET /api/personas/:id`: the Persona with its revisions, newest first, and `exposedTools`, the names of the native MCP
 * tools its own setup gives its answers now (ADR 0101, `<server>__<tool>`): those its servers list that the model may
 * call and the owner granted, and none for a Persona that reaches its tools through the gateway (`tools`, ADR 0102). A
 * Topic that adds servers adds tools to these; a server's thread adds its own.
 */
export const PersonaDetail = Schema.Struct({
  persona: PersonaView,
  revisions: Schema.Array(PersonaRevisionView),
  exposedTools: Schema.Array(Schema.String),
})
export type PersonaDetail = typeof PersonaDetail.Type

/**
 * Why a Persona gave no answer (ADR 0083): its model gave none, also when asked again (`no_answer`), its model call
 * failed (`model_error`), the day's model budget is spent (`budget`), or it could not run or place its answer
 * (`unavailable`: the owner's authority lapsed, or the message or chat is gone).
 */
export const PersonaFailure = Schema.Literals(['no_answer', 'model_error', 'budget', 'unavailable'])
export type PersonaFailure = typeof PersonaFailure.Type

/**
 * One tagged Persona answering one owner message: `order` is its place when the owner asked them in sequence ("then"),
 * otherwise they answer in parallel. `fork` is the Persona's own chat once it started, the `subagentRunId` its work
 * streams under in `chat`'s stream (docs/architecture/streams.md). `answerEntry` is the attributed answer written into
 * `chat`; `reason` says why a failed one gave none.
 */
export const PersonaInvocationView = Schema.Struct({
  operationId: OperationId,
  persona: PersonaId,
  revision: Schema.Int,
  chat: ChatId,
  order: Schema.Int,
  state: Schema.Literals(['pending', 'running', 'answered', 'failed', 'stopped']),
  fork: Schema.optional(ChatId),
  answerEntry: Schema.optional(EntryId),
  reason: Schema.optional(PersonaFailure),
  createdAt: Schema.Number,
  settledAt: Schema.optional(Schema.Number),
})
export type PersonaInvocationView = typeof PersonaInvocationView.Type

/** Who a tagged message went to: each Persona at the revision the invocation froze. */
export const PersonaTag = Schema.Struct({ id: PersonaId, name: Schema.String, revision: Schema.Int })

/** `app.persona_ask` entry data: the owner's message went to these Personas, not to Goblin. */
export const PersonaAskData = Schema.Struct({
  personas: Schema.Array(PersonaTag).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  order: Schema.Literals(['parallel', 'sequence']),
})
export type PersonaAskData = typeof PersonaAskData.Type

/**
 * What a Persona's answer waits on (ADRs 0041, 0042): a held call the owner approves or refuses, a tool the owner
 * allows, a URL request the owner finishes or cancels, or a sign-in with more access. `fork` is the Persona's own chat,
 * which goes on from the owner's reply.
 */
export const PersonaHold = Schema.Struct({
  /**
   * What the Persona waits on: approval of its held call, a tool to allow, a URL request to finish (`url`), a sign-in
   * with more access (`access`, ADR 0042) or a connection to sign in to (`connect`, ADR 0063).
   */
  kind: Schema.Literals(['approval', 'grant', 'url', 'access', 'connect']),
  /** The held call, for an approval. */
  approvalId: Schema.optional(Schema.String),
  /** The URL request, for `url`. */
  requestId: Schema.optional(Schema.String),
  /** The scope the server asked for, for `access`; empty when it named none. */
  scope: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  connectionId: Schema.String,
  name: Schema.String,
  fork: ChatId,
})
export type PersonaHold = typeof PersonaHold.Type

/**
 * `app.persona` entry data: one Persona's attributed answer, written into the chat it was asked in, or into its
 * routine's Topic when a routine handed it the work.
 */
export const PersonaAnswerData = Schema.Struct({
  persona: PersonaId,
  name: Schema.String,
  revision: Schema.Int,
  avatar: PersonaAvatar,
  operationId: OperationId,
  text: Schema.String,
  /** The routine run that handed the Persona its work (ADR 0041), when no owner message did. */
  routine: Schema.optional(Schema.Struct({ id: Schema.String, run: Schema.String })),
  /** What the answer stopped on, when the Persona needs the owner before it can go on (ADR 0041). */
  hold: Schema.optional(PersonaHold),
  /** What the Persona asked with `ask_user` (ADR 0082): the answer ends there and the owner's next tag answers it. */
  questions: Schema.optional(Schema.Array(QuestionSpec)),
  /**
   * The Persona's own chat it answered in (its fork, ADR 0033), when it answered in one rather than in a routine's run:
   * the `subagentRunId` its work streamed under (docs/architecture/streams.md).
   */
  fork: Schema.optional(ChatId),
})
export type PersonaAnswerData = typeof PersonaAnswerData.Type

/** A Persona's answer as plain text: its words, then what it asked, numbered, for every reader that shows only text. */
export function personaAnswerText(answer: Pick<PersonaAnswerData, 'text' | 'questions'>): string {
  const questions = answer.questions ?? []
  if (questions.length === 0) return answer.text
  const asked = `Asked:\n${questionText(questions)}`
  return answer.text === '' ? asked : `${answer.text}\n\n${asked}`
}

/**
 * `POST /api/personas/reply`: the owner's reply to a Persona's hold (ADR 0041), after they allowed the tool it asked
 * for. The Persona goes on in its fork and answers again; the same operation id answers once.
 */
export const PersonaReply = Schema.Struct({
  fork: ChatId,
  operationId: OperationId,
  text: NonEmptyString(4000),
})
export type PersonaReply = typeof PersonaReply.Type
