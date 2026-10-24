import * as Schema from 'effect/Schema'
import { ComposerSelections } from '../composer.ts'
import { FilePath } from '../files.ts'
import { AppId, NonEmptyString, OperationId } from '../ids.ts'

// A send is AG-UI's `RunAgentInput` (ADR 0111, `@ag-ui/core` 1.0.3): `POST /api/conversations/:id/messages` takes one,
// and so does the first message of a thread operation. goblin decodes it with its own limits: the last message is the
// send's words (a stock client resends the whole history, which goblin's transcript already holds), the run id is the
// operation id, and goblin's parts ride in `forwardedProps.goblin`.

/** The most of the owner's words one message carries. */
export const MAX_MESSAGE = 20_000

/** The most Apps whose context one owner message carries. */
export const MAX_APP_CONTEXT = 2

/**
 * What an open App shared for the agent (`ui/update-model-context`), sent with the owner's next message by its App id.
 * The runtime finds where the App comes from (its server, or the agent app it is) and passes the text to the model as
 * a separate block labelled untrusted, never as the owner's words.
 */
export const AppContext = Schema.Struct({
  app: AppId,
  text: NonEmptyString(8192),
})
export type AppContext = typeof AppContext.Type

/**
 * goblin's parts of a send, `forwardedProps.goblin`: the owner's files, the composer's tags (Personas tagged answer
 * instead of Goblin, in parallel unless `personaOrder` is `sequence`, "then"), and what open Apps shared. A credential
 * sends only Persona tags of the Personas it reaches.
 */
export const SendExtras = Schema.Struct({
  attachments: Schema.optional(Schema.Array(FilePath).check(Schema.isMaxLength(8))),
  selections: Schema.optional(ComposerSelections),
  personaOrder: Schema.optional(Schema.Literals(['parallel', 'sequence'])),
  appContext: Schema.optional(Schema.Array(AppContext).check(Schema.isMaxLength(MAX_APP_CONTEXT))),
})
export type SendExtras = typeof SendExtras.Type

/**
 * An answer to one of the chat's interrupts (AG-UI's `ResumeEntry`): `interruptId` is the item's id in the chat's
 * `/attention` (`<chat>:i<entry>`). A resolved question's `payload` is the owner's answer, as text.
 */
export const ResumeEntry = Schema.Struct({
  interruptId: NonEmptyString(200),
  status: Schema.Literals(['resolved', 'cancelled']),
  payload: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
})
export type ResumeEntry = typeof ResumeEntry.Type

/** AG-UI's `Context`: a named piece of ambient information. goblin reads none of it (ADR 0111). */
const RunContext = Schema.Struct({ description: Schema.String, value: Schema.String })

/**
 * A send: AG-UI's `RunAgentInput` as goblin takes it. `threadId` is the chat the path names, `runId` the operation id
 * (the same id is the same send), and the last of `messages` the send's user message; the others are read no further,
 * whatever they hold. `tools` and `state` must be empty or absent (goblin runs its own tools), `context` is ignored,
 * and `forwardedProps` is an object whose `goblin` holds goblin's parts (its other keys are ignored).
 */
export const RunInput = Schema.Struct({
  threadId: Schema.String,
  runId: OperationId,
  protocolVersion: Schema.optional(Schema.String),
  parentRunId: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Unknown),
  messages: Schema.Array(Schema.Unknown),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  context: Schema.optional(Schema.Array(RunContext)),
  forwardedProps: Schema.optional(Schema.Struct({ goblin: Schema.optional(SendExtras) })),
  resume: Schema.optional(Schema.Array(ResumeEntry).check(Schema.isMaxLength(32))),
})
export type RunInput = typeof RunInput.Type

/**
 * The last message of a send, as goblin reads it: a user message whose content is its words, or parts of which only
 * text is taken (`TextPart`); files go in `forwardedProps.goblin.attachments`.
 */
export const RunUserMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal('user'),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  name: Schema.optional(Schema.String),
})
export type RunUserMessage = typeof RunUserMessage.Type

/** A text part of a user message (AG-UI's `TextPart`). */
export const TextPart = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })

/**
 * A send as plain fields: its words, its operation id and goblin's parts. What the MCP tool `conversation_send` takes,
 * a model writes more easily than an AG-UI body; `runInput` makes the body of it.
 */
export const PlainSend = Schema.Struct({
  input: Schema.String.check(Schema.isMaxLength(MAX_MESSAGE)),
  operationId: OperationId,
  ...SendExtras.fields,
})
export type PlainSend = typeof PlainSend.Type

/** `extras` without the parts left empty, or none when nothing is left. */
function nonEmpty({ attachments = [], selections = [], appContext = [], personaOrder }: SendExtras) {
  const kept = {
    ...(attachments.length > 0 && { attachments }),
    ...(selections.length > 0 && { selections }),
    ...(appContext.length > 0 && { appContext }),
    ...(personaOrder !== undefined && { personaOrder }),
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/**
 * The AG-UI body of `send` into chat `chat`: one user message (its id the operation's), the operation id as the run's,
 * and goblin's parts in `forwardedProps.goblin` when there are any.
 */
export function runInput(chat: string, { input, operationId, ...extras }: PlainSend): RunInput {
  const goblin = nonEmpty(extras)
  return {
    threadId: chat,
    runId: operationId,
    messages: [{ id: operationId, role: 'user', content: input }],
    ...(goblin === undefined ? {} : { forwardedProps: { goblin } }),
  }
}
