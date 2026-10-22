import type { Event, Interrupt, Message } from '@ag-ui/core'
import * as Schema from 'effect/Schema'

// A chat's stream speaks AG-UI 1.0 (`@ag-ui/core`, pinned): its events, messages and interrupts are AG-UI's own types,
// used as they are. This package adds only goblin's parts: the CUSTOM events, the activity types, the
// `metadata.goblin` fields and the STATE document (docs/architecture/streams.md).

export { EventType } from '@ag-ui/core'
/** One AG-UI 1.0 event, as a chat's stream carries it. */
export type AguiEvent = Event
/** One AG-UI 1.0 message, as a `MESSAGES_SNAPSHOT` carries it. */
export type AguiMessage = Message
/** What a run waits for when it finishes with the `interrupt` outcome; goblin's are `AttentionItem`s. */
export type AguiInterrupt = Interrupt

/** The CUSTOM event names goblin sends; any other name is not goblin's. */
export const CustomName = {
  /** A running tool's progress (`ToolProgress`). */
  toolProgress: 'goblin.tool_progress',
} as const

/** A tool diagnostic as Pi records it: a remark about the call the model reads too. */
const ToolDiagnostic = Schema.Struct({
  severity: Schema.Literals(['info', 'warn', 'error']),
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
})

/**
 * `goblin.tool_progress`: what a running tool published. `status: 'running'` once, when it starts executing; then its
 * output as a replacement (`set`) or a front trim of what was kept followed by an append, its newest details and its
 * diagnostics. Pi bounds the output a tool keeps, so `trimStart` drops characters from the front of the text so far.
 */
export const ToolProgress = Schema.Struct({
  toolCallId: Schema.String,
  status: Schema.optionalKey(Schema.Literal('running')),
  output: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ set: Schema.String }),
      Schema.Struct({ trimStart: Schema.optionalKey(Schema.Int), append: Schema.optionalKey(Schema.String) }),
    ]),
  ),
  details: Schema.optionalKey(Schema.Json),
  diagnostics: Schema.optionalKey(Schema.Array(ToolDiagnostic)),
})
export type ToolProgress = typeof ToolProgress.Type
