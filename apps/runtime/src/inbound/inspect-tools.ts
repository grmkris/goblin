import { ChatId, EntryId, OperationId } from '@goblin/contracts'
import { FlowName } from '@goblin/contracts/telemetry'
import type { McpServer } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { type Add, Limit, type Reply, reads, standard } from './tools.ts'

// The inspection tools on /mcp (ADRs 0024, 0084, 0086): content-free reads of how chats ran for `inspect`, and the
// conversations in full for `transcripts`, which only an OAuth client of the owner holds.

const Since = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description: 'Only what started since this time, in epoch milliseconds; the last day without it.',
})
export const Chat = ChatId.annotate({
  description: "A chat within reach: a Topic's Conversation or a thread (its id in /c/<id> URLs).",
})
const Operation = OperationId.annotate({
  description: "An operation id: one the caller sent, or one inspect_turns, inspect_flows or a details' related names.",
})

/** `inspect_details`' input: an operation, or a chat with one of its entries. */
const DetailsInput = Schema.Struct({
  operation: Schema.optional(Operation),
  chat: Schema.optional(Chat.annotate({ description: 'With `entry`: the chat the entry is in.' })),
  entry: Schema.optional(
    EntryId.annotate({ description: 'With `chat`: an entry id; the details of the operation that wrote it.' }),
  ),
})

/** `inspect_turns`, `inspect_turn` and `inspect_problems`: how the chats within reach ran, content-free (ADR 0084). */
export const runTools = (server: McpServer, add: Add, reply: Reply) => {
  add('inspect_turns', () =>
    server.registerTool(
      'inspect_turns',
      {
        title: 'Recent turns',
        description:
          "Recent turns of the chats within reach (Personas' answers included), newest first, one line each: where it came from, how it ended, model attempts, tool calls, failures and tokens.",
        inputSchema: standard(
          Schema.Struct({
            conversation: Schema.optional(Chat),
            since: Schema.optional(Since),
            limit: Schema.optional(Limit),
          }),
        ),
        annotations: reads,
      },
      ({ conversation, since, limit }) =>
        reply((api) =>
          api.inspect.turns({
            query: {
              ...(conversation === undefined ? {} : { conversation }),
              ...(since === undefined ? {} : { since }),
              ...(limit === undefined ? {} : { limit }),
            },
          }),
        ),
    ),
  )
  add('inspect_turn', () =>
    server.registerTool(
      'inspect_turn',
      {
        title: 'One turn end to end',
        description:
          "One turn by its operation id: Pi's settlement of it, its steps in order (model attempts with model, tokens, finish reason and time to first chunk; tool calls with the MCP server and tool, outcome and failure class), each with its start offset and duration, and `spent`: wall time, model time, tool time by server and the rest (waiting).",
        inputSchema: standard(Schema.Struct({ operation: Operation })),
        annotations: reads,
      },
      ({ operation }) => reply((api) => api.inspect.turn({ query: { operation } })),
    ),
  )
  add('inspect_problems', () =>
    server.registerTool(
      'inspect_problems',
      {
        title: 'Recent problems',
        description:
          'Events of the chats within reach needing attention since a time, newest first: failures, cutoffs, empty answers and coverage gaps. `all` includes expected waits and recovered attempts.',
        inputSchema: standard(
          Schema.Struct({
            since: Schema.optional(Since),
            limit: Schema.optional(Limit),
            all: Schema.optional(Schema.Boolean),
          }),
        ),
        annotations: reads,
      },
      ({ since, limit, all }) =>
        reply((api) =>
          api.inspect.problems({
            query: {
              ...(since === undefined ? {} : { since }),
              ...(limit === undefined ? {} : { limit }),
              ...(all === undefined ? {} : { all }),
            },
          }),
        ),
    ),
  )
}

/** `inspect_flows` and `inspect_details`: how the chats within reach moved, and what happened behind one message. */
export const flowTools = (server: McpServer, add: Add, reply: Reply) => {
  add('inspect_flows', () =>
    server.registerTool(
      'inspect_flows',
      {
        title: 'Conversation flows',
        description:
          'How the chats within reach moved, newest first and content-free: sends, Persona asks and answers, thread starts. Each step names its flow, who acted, its chat and operation ids, timing and how it ended. Filter by `chat` or `flow`.',
        inputSchema: standard(
          Schema.Struct({
            since: Schema.optional(Since),
            limit: Schema.optional(Limit),
            chat: Schema.optional(Chat),
            flow: Schema.optional(FlowName),
          }),
        ),
        annotations: reads,
      },
      ({ since, limit, chat, flow }) =>
        reply((api) =>
          api.inspect.flows({
            query: {
              ...(since === undefined ? {} : { since }),
              ...(limit === undefined ? {} : { limit }),
              ...(chat === undefined ? {} : { chat }),
              ...(flow === undefined ? {} : { flow }),
            },
          }),
        ),
    ),
  )
  add('inspect_details', () =>
    server.registerTool(
      'inspect_details',
      {
        title: 'Details of one operation',
        description:
          "What happened behind one message: give its `operation`, or `chat` with an `entry`. Its turn summary, steps and time when it ran a turn, every run event in order, and the operations related to it (its Personas' answers, a thread's first send).",
        inputSchema: standard(DetailsInput),
        annotations: reads,
      },
      ({ operation, chat, entry }) =>
        reply((api) =>
          api.inspect.details({
            query: {
              ...(operation === undefined ? {} : { operation }),
              ...(chat === undefined ? {} : { chat }),
              ...(entry === undefined ? {} : { entry }),
            },
          }),
        ),
    ),
  )
}

/** `inspect_conversations` and `inspect_conversation`: the conversations in full, for a caller with `transcripts`. */
export const transcriptTools = (server: McpServer, add: Add, reply: Reply) => {
  add('inspect_conversations', () =>
    server.registerTool(
      'inspect_conversations',
      {
        title: 'Conversations',
        description: 'Every conversation the agent keeps (main, threads, subagents, clients) with titles and activity.',
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.inspect.conversations()),
    ),
  )
  add('inspect_conversation', () =>
    server.registerTool(
      'inspect_conversation',
      {
        title: 'Conversation entries',
        description:
          "A page of one conversation's entries, oldest first, in full: messages with their author, each answer's visible thinking, tool calls with arguments, tool results, and each answer's model, stop reason, error and tokens. Long text is cut and marked `truncated`. Pass `before` (the first entry's id) for the page before.",
        inputSchema: standard(
          Schema.Struct({
            conversation: Chat,
            before: Schema.optional(
              EntryId.annotate({ description: 'Entries before this entry id, from the last page.' }),
            ),
          }),
        ),
        annotations: reads,
      },
      ({ conversation, before }) =>
        reply((api) =>
          api.inspect.conversation({ query: { conversation, ...(before === undefined ? {} : { before }) } }),
        ),
    ),
  )
}
