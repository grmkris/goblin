import * as Schema from 'effect/Schema'
import { ChatId, EntryId, OperationId } from './ids.ts'
import { ConversationView } from './conversations.ts'
import { FlowEvent, FlowName, RunEvent, RunEventKind, RunEventStatus } from './telemetry.ts'

/**
 * Read-only inspection of one agent (ADR 0024): its conversations, a conversation's entries, its turns and their
 * timelines, what went wrong, its conversation flows and the details behind a message. Full content for conversations,
 * bounded and paged; no reads call a model.
 */
const Session = ChatId.annotate({
  description: 'A conversation id as `inspect_conversations` lists it; "1" is the main conversation.',
})
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
  description: 'At most this many, 1 to 100.',
})
const Since = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description: 'Only what started since this time, in epoch milliseconds. Without it, the last day.',
})

/** `inspect_flows`' input: recent conversation flows, optionally of one chat or one flow. */
export const InspectFlowsInput = Schema.Struct({
  since: Schema.optional(Since),
  limit: Schema.optional(Limit),
  chat: Schema.optional(ChatId.annotate({ description: 'Only the flows of this chat (its id in /c/<id> URLs).' })),
  flow: Schema.optional(FlowName.annotate({ description: 'Only the steps of this flow (`reply`, `move`, …).' })),
})
export type InspectFlowsInput = typeof InspectFlowsInput.Type

/** What the details reader takes: one operation, or the operation that wrote an entry of a chat. */
export const InspectDetailsInput = Schema.Union([
  Schema.Struct({ operation: OperationId }),
  Schema.Struct({ chat: ChatId, entry: EntryId }),
])
export type InspectDetailsInput = typeof InspectDetailsInput.Type

/**
 * `inspect_details`' input as one flat object, because a tool's input schema is an object: `operation`, or `chat` with
 * `entry`. The reader takes it as {@link InspectDetailsInput} and refuses any other combination.
 */
const DetailsArguments = Schema.Struct({
  operation: Schema.optional(
    OperationId.annotate({
      description: 'An operation id, from `inspect_turns`, `inspect_problems` or `inspect_flows`.',
    }),
  ),
  chat: Schema.optional(
    ChatId.annotate({ description: 'With `entry`: the chat the entry is in (its id in /c/<id> URLs).' }),
  ),
  entry: Schema.optional(
    EntryId.annotate({
      description: 'With `chat`: an entry id; the details are those of the operation that wrote it.',
    }),
  ),
})
export type InspectDetailsArguments = typeof DetailsArguments.Type

/** What each query takes apart from its kind: the inputs of the inspection tools. */
export const InspectInput = {
  conversations: Schema.Struct({}),
  conversation: Schema.Struct({
    conversation: Session,
    before: Schema.optional(
      EntryId.annotate({
        description: 'Entries before this entry id, from the last page; the newest page without it.',
      }),
    ),
  }),
  turns: Schema.Struct({
    conversation: Schema.optional(Session),
    since: Schema.optional(Since),
    limit: Schema.optional(Limit),
  }),
  turn: Schema.Struct({
    operationId: OperationId.annotate({
      description: "The turn's operation id, from `inspect_turns` or `inspect_problems`.",
    }),
  }),
  problems: Schema.Struct({
    since: Schema.optional(Since),
    limit: Schema.optional(Limit),
    all: Schema.optional(Schema.Boolean).annotate({
      description: 'Include expected waits and confirmed recovered attempts; default shows events needing attention.',
    }),
  }),
  flows: InspectFlowsInput,
  details: DetailsArguments,
}
export type InspectKind = keyof typeof InspectInput

export const InspectQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('conversations'), ...InspectInput.conversations.fields }),
  Schema.Struct({ kind: Schema.Literal('conversation'), ...InspectInput.conversation.fields }),
  Schema.Struct({ kind: Schema.Literal('turns'), ...InspectInput.turns.fields }),
  Schema.Struct({ kind: Schema.Literal('turn'), ...InspectInput.turn.fields }),
  Schema.Struct({ kind: Schema.Literal('problems'), ...InspectInput.problems.fields }),
  Schema.Struct({ kind: Schema.Literal('flows'), ...InspectInput.flows.fields }),
  Schema.Struct({ kind: Schema.Literal('details'), ...InspectInput.details.fields }),
])
export type InspectQuery = typeof InspectQuery.Type

export const InspectConversations = Schema.Struct({ conversations: Schema.Array(ConversationView) })
export type InspectConversations = typeof InspectConversations.Type

/** One Pi entry as a reader needs it. Long text is cut (`truncated`); nothing is summarized or rewritten. */
export const InspectEntry = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  role: Schema.optional(Schema.String),
  /** Who wrote a user message, when it was not the owner in the app (an MCP client, Source). */
  author: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** An answer's visible thinking, before its text and calls (redacted thinking is left out). */
  thinking: Schema.optional(Schema.String),
  /** The calls an answer made, with their arguments as JSON. */
  toolCalls: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.String })),
  ),
  /** For a tool result: which call it answers and whether it failed. */
  tool: Schema.optional(Schema.Struct({ callId: Schema.String, name: Schema.String, isError: Schema.Boolean })),
  /** For an answer: the model, why it stopped, its error and tokens. */
  model: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      stopReason: Schema.String,
      error: Schema.optional(Schema.String),
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cacheReadTokens: Schema.Number,
    }),
  ),
  /** Pi's own JSON for entries without messages (`app.*`, compaction), as text. */
  data: Schema.optional(Schema.String),
  /** When the message was made, epoch ms. */
  at: Schema.optional(Schema.Number),
  /** The Pi task that wrote it: joins the turn's run events. */
  task: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
})
export type InspectEntry = typeof InspectEntry.Type

/** A page of a conversation's entries, oldest first; `before` asks for the page before it. */
export const InspectEntries = Schema.Struct({
  conversation: Schema.String,
  entries: Schema.Array(InspectEntry),
  before: Schema.optional(Schema.Number),
})
export type InspectEntries = typeof InspectEntries.Type

/** One turn in a line: where it came from, how it ended, what it took. */
export const TurnSummary = Schema.Struct({
  operationId: Schema.String,
  conversationId: Schema.optional(Schema.String),
  source: Schema.String,
  status: RunEventStatus,
  reason: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  modelAttempts: Schema.Number,
  failedAttempts: Schema.Number,
  toolCalls: Schema.Number,
  failedToolCalls: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** Its `error` events; a reader older than the field sees none. */
  errors: Schema.optional(Schema.Number),
  /** The release it was submitted on, its commit (ADR 0107). */
  version: Schema.optional(Schema.String),
})
export type TurnSummary = typeof TurnSummary.Type

export const InspectTurns = Schema.Struct({ turns: Schema.Array(TurnSummary) })
export type InspectTurns = typeof InspectTurns.Type

/** What a timeline could not show, so a reader never mistakes a gap for nothing having happened. */
export const Coverage = Schema.Struct({ complete: Schema.Boolean, gaps: Schema.Array(Schema.String) })

const Ms = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Which endpoint a model call went to (ADR 0107): the deployment's, the owner's own (ADR 0059), or none. */
export const ModelEndpointKind = Schema.Literals(['deployment', 'owner', 'none'])
export type ModelEndpointKind = typeof ModelEndpointKind.Type

/**
 * One step of a turn in order, content-free (ADR 0084): a model attempt, a tool call, a compaction or an error, when
 * it started after the turn did (`offsetMs`) and how long it took (`ms`, none while it runs). A model attempt names
 * its model, tokens, why it finished and how long until its first chunk; a tool call its tool, the MCP server and tool
 * it reached, and the class of its failure or block. Each says what it ran with (ADR 0107): the release; a model
 * attempt its endpoint, thinking level and the prompt sections and tools that changed before it; an MCP tool call the
 * server's own name and version.
 */
export const TurnStep = Schema.Struct({
  kind: RunEventKind,
  status: RunEventStatus,
  offsetMs: Ms,
  ms: Schema.optional(Ms),
  model: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  finishReason: Schema.optional(Schema.String),
  firstChunkMs: Schema.optional(Ms),
  tool: Schema.optional(Schema.String),
  server: Schema.optional(Schema.String),
  serverTool: Schema.optional(Schema.String),
  errorType: Schema.optional(Schema.String),
  blockedReason: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  endpoint: Schema.optional(ModelEndpointKind),
  thinking: Schema.optional(Schema.String),
  /** Keys of the prompt sections that changed before this attempt. */
  promptSections: Schema.optional(Schema.Array(Schema.String)),
  /** The prompt was restated after compaction, not changed. */
  promptBaseline: Schema.optional(Schema.Boolean),
  toolsAdded: Schema.optional(Schema.Int),
  toolsRemoved: Schema.optional(Schema.Int),
  /** The tools added or removed, for a change of at most eight. */
  toolsChanged: Schema.optional(Schema.Array(Schema.String)),
  serverName: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
})
export type TurnStep = typeof TurnStep.Type

/**
 * What a turn ran with, in one place (ADR 0107): the releases its events ran on (more than one when the agent restarted
 * into a new one mid-turn), the endpoints and thinking levels of its model attempts, how many attempts came after a
 * change of the prompt or tools (a restatement after compaction is none), and the MCP servers it reached as they
 * report themselves.
 */
export const TurnRanWith = Schema.Struct({
  versions: Schema.Array(Schema.String),
  endpoints: Schema.Array(ModelEndpointKind),
  thinking: Schema.Array(Schema.String),
  promptChanges: Schema.Int,
  servers: Schema.Array(
    Schema.Struct({
      server: Schema.String,
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
})
export type TurnRanWith = typeof TurnRanWith.Type

/**
 * Where a turn's time went (ADR 0084): its wall time (to now while it runs), the summed time of its model attempts and
 * of its tool calls, the tool time by MCP server, and `otherMs`, the wall time neither covers (waiting, queueing,
 * the host's own work). Tool calls can run side by side, so the sums can pass the wall time; `otherMs` is never below 0.
 */
export const TurnSpent = Schema.Struct({
  totalMs: Ms,
  modelMs: Ms,
  toolMs: Ms,
  servers: Schema.Array(Schema.Struct({ server: Schema.String, calls: Schema.Int, ms: Ms })),
  otherMs: Ms,
})
export type TurnSpent = typeof TurnSpent.Type

/**
 * One turn end to end: Pi's own settlement of the submission, every run event of it in order with its steps and where
 * its time went, and the entries it spans (read them with a `conversation` query, `before` the answer).
 */
export const TurnTimeline = Schema.Struct({
  turn: TurnSummary,
  submission: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      entry: Schema.optional(Schema.Number),
      answer: Schema.optional(Schema.Number),
      reason: Schema.optional(Schema.String),
    }),
  ),
  events: Schema.Array(RunEvent),
  steps: Schema.Array(TurnStep),
  spent: TurnSpent,
  ranWith: TurnRanWith,
  coverage: Coverage,
})
export type TurnTimeline = typeof TurnTimeline.Type

/** Events needing attention since `since`, newest first; `all` includes expected waits and recovered attempts. */
export const InspectProblems = Schema.Struct({ since: Schema.Number, problems: Schema.Array(RunEvent) })
export type InspectProblems = typeof InspectProblems.Type

/** One recorded flow event and when it was recorded (epoch ms). */
export const FlowRecord = Schema.Struct({ ...FlowEvent.fields, at: Schema.Number })
export type FlowRecord = typeof FlowRecord.Type

/** Flow events since `since`, newest first. */
export const InspectFlows = Schema.Struct({ since: Schema.Number, flows: Schema.Array(FlowRecord) })
export type InspectFlows = typeof InspectFlows.Type

/** An operation linked to the one in view: its parent, the thread it started, the Personas it asked. */
export const RelatedOperation = Schema.Struct({
  operation: OperationId,
  kind: Schema.String.check(Schema.isMaxLength(80)),
  chat: Schema.optional(ChatId),
  state: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
})
export type RelatedOperation = typeof RelatedOperation.Type

/**
 * A message's details: the timeline of the operation behind it (a passive write has no turn, so `turn` is optional)
 * and the operations related to it.
 */
export const InspectDetails = Schema.Struct({
  ...TurnTimeline.fields,
  turn: Schema.optional(TurnSummary),
  steps: Schema.optional(TurnTimeline.fields.steps),
  spent: Schema.optional(TurnSpent),
  ranWith: Schema.optional(TurnRanWith),
  related: Schema.Array(RelatedOperation),
})
export type InspectDetails = typeof InspectDetails.Type

/** What each query answers. */
export const InspectResult = {
  conversations: InspectConversations,
  conversation: InspectEntries,
  turns: InspectTurns,
  turn: TurnTimeline,
  problems: InspectProblems,
  flows: InspectFlows,
  details: InspectDetails,
}
