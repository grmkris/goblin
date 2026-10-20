import {
  ChatId,
  CreatePersona,
  CreateTopic,
  EntryId,
  NonEmptyString,
  OperationId,
  PageCursor,
  SendMessage,
  StartThread,
  StopConversation,
  TopicSetupEdit,
  UpdatePersona,
  UpdateTopic,
} from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { FlowName } from '@goblin/contracts/telemetry'
import { McpServer } from '@modelcontextprotocol/server'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { OwnerClient } from './client.ts'
import { failed, standard, text } from './tools.ts'

/**
 * goblin's /mcp for a server's API key (ADR 0081): one tool per owner endpoint a key reaches, each calling that endpoint
 * as the key, so what a key may do over MCP is exactly what it may do over HTTP.
 */

/** One typed owner API call as the key: its value, or a rejection with the agent's `AppError`. */
export type OwnerCaller = <A>(call: (api: OwnerClient) => Effect.Effect<A, unknown>) => Promise<A>

/**
 * Each tool, by the endpoint it calls (`<group>.<endpoint>`).
 *
 * @internal The parity test holds it to the endpoints annotated `ApiKeyScope`, one to one.
 */
export const KEY_TOOLS = {
  topic_list: 'topics.list',
  topic_get: 'topics.get',
  topic_create: 'topics.create',
  topic_update: 'topics.update',
  topic_set_setup: 'topics.setSetup',
  conversation_send: 'conversations.submit',
  thread_start: 'conversations.startThread',
  conversation_entries: 'conversations.entries',
  conversation_stop: 'conversations.stop',
  persona_list: 'personas.list',
  models_list: 'agent.models',
  persona_create: 'personas.create',
  persona_get: 'personas.detail',
  persona_update: 'personas.update',
  inspect_turns: 'inspect.turns',
  inspect_turn: 'inspect.turn',
  inspect_problems: 'inspect.problems',
  inspect_flows: 'inspect.flows',
  inspect_details: 'inspect.details',
} as const

const Id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const After = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Cursor = PageCursor.annotate({ description: 'The `next` of the page before; the first page without it.' })
const Page = { cursor: Schema.optional(Cursor), limit: Schema.optional(Limit) }

/** A page's query as the endpoint takes it: only what the tool was given. */
const pageQuery = ({
  cursor,
  limit,
}: {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) => ({
  ...(cursor === undefined ? {} : { cursor }),
  ...(limit === undefined ? {} : { limit }),
})

const GUIDE =
  "goblin for a server's API key: the key makes, lists and uses its own Topics, their chats and its own Personas, never the owner's. Setups name only the MCP servers on the key, tool by tool, and a Persona's model one models_list offers. Send with conversation_send or thread_start, then read replies with conversation_entries after the cursor it last returned. With the inspect scope, the inspect_* tools show how the key's own chats ran, content-free: inspect_details of an operation it sent lists its Personas' answers under related (persona:<operation>:<persona id>), and inspect_turn of one shows its steps in order and where its time went."

/** One call's answer as the tool's result, or the agent's refusal as its error result. */
const replyWith =
  (call: OwnerCaller) =>
  async <A>(run: (api: OwnerClient) => Effect.Effect<A, unknown>) => {
    try {
      return text(await call(run))
    } catch (cause) {
      // expected: the failure is the tool's error result, its tag and safe fields only (tools.ts).
      return failed(cause)
    }
  }
type Reply = ReturnType<typeof replyWith>

const writes = { readOnlyHint: false, openWorldHint: false } as const
const reads = { readOnlyHint: true, openWorldHint: false } as const

/** `topic_list`, `topic_get`, `topic_create`, `topic_update` and `topic_set_setup`. */
const topicTools = (server: McpServer, reply: Reply) => {
  server.registerTool(
    'topic_list',
    {
      title: "List the key's Topics",
      description:
        "A page of the key's Topics, newest change first: id, name, conversation (its chat), revision, archived, searchExcluded and updatedAt. Pass `next` back as `cursor` for the page after.",
      inputSchema: standard(Schema.Struct(Page)),
      annotations: reads,
    },
    (query) => reply((api) => api.topics.list({ query: pageQuery(query) })),
  )
  server.registerTool(
    'topic_get',
    {
      title: 'Read a Topic',
      description: "One of the key's Topics as it is now: its description, instructions, revision and setup.",
      inputSchema: standard(Schema.Struct({ id: Id })),
      annotations: reads,
    },
    ({ id }) => reply((api) => api.topics.get({ params: { id } })),
  )
  server.registerTool(
    'topic_create',
    {
      title: 'Make a Topic',
      description: 'A Topic of the key, with its own Conversation.',
      inputSchema: standard(CreateTopic),
      annotations: writes,
    },
    (payload) => reply((api) => api.topics.create({ payload })),
  )
  server.registerTool(
    'topic_update',
    {
      title: 'Change a Topic',
      description: "Rename, archive or change the search opt-out or guidance of one of the key's Topics.",
      inputSchema: standard(Schema.Struct({ id: Id, change: UpdateTopic })),
      annotations: writes,
    },
    ({ id, change }) => reply((api) => api.topics.update({ params: { id }, payload: change })),
  )
  server.registerTool(
    'topic_set_setup',
    {
      title: "Change a Topic's setup",
      description: "What one of the key's Topics works with, within the key's servers.",
      inputSchema: standard(Schema.Struct({ id: Id, edit: TopicSetupEdit })),
      annotations: writes,
    },
    ({ id, edit }) =>
      reply((api) =>
        // The client takes each variant of the edit on its own.
        'set' in edit
          ? api.topics.setSetup({ params: { id }, payload: edit })
          : 'add' in edit
            ? api.topics.setSetup({ params: { id }, payload: edit })
            : api.topics.setSetup({ params: { id }, payload: edit }),
      ),
  )
}

/** `conversation_send`, `thread_start`, `conversation_entries` and `conversation_stop`. */
const conversationTools = (server: McpServer, reply: Reply) => {
  server.registerTool(
    'conversation_send',
    {
      title: 'Send a message',
      description: "A message into one of the key's chats, or an ask of the key's Personas it tags.",
      inputSchema: standard(Schema.Struct({ chat: ChatId, message: SendMessage })),
      annotations: writes,
    },
    ({ chat, message }) => reply((api) => api.conversations.submit({ params: { id: chat }, payload: message })),
  )
  server.registerTool(
    'thread_start',
    {
      title: 'Start a thread',
      description: "A Thread from one of the key's chats, its first message answered there.",
      inputSchema: standard(Schema.Struct({ chat: ChatId, thread: StartThread })),
      annotations: writes,
    },
    ({ chat, thread }) => reply((api) => api.conversations.startThread({ params: { id: chat }, payload: thread })),
  )
  server.registerTool(
    'conversation_entries',
    {
      title: "Read a chat's entries",
      description: "A chat's entries after a cursor (0 for the first), oldest first, with the next cursor.",
      inputSchema: standard(Schema.Struct({ chat: ChatId, after: After, limit: Schema.optional(Limit) })),
      annotations: reads,
    },
    ({ chat, after, limit }) =>
      reply((api) =>
        api.conversations.entries({
          params: { id: chat },
          query: { after, ...(limit === undefined ? {} : { limit }) },
        }),
      ),
  )
  server.registerTool(
    'conversation_stop',
    {
      title: 'Stop a chat',
      description: "Stop what one of the key's chats is doing.",
      inputSchema: standard(Schema.Struct({ chat: ChatId, stop: StopConversation })),
      annotations: writes,
    },
    ({ chat, stop }) => reply((api) => api.conversations.stop({ params: { id: chat }, payload: stop })),
  )
}

/** `persona_list`, `models_list`, `persona_create`, `persona_get` and `persona_update`. */
const personaTools = (server: McpServer, reply: Reply) => {
  server.registerTool(
    'persona_list',
    {
      title: "List the key's Personas",
      description:
        "A page of the key's Personas, newest change first: id, name, role, avatar, revision, model, its setup in a line (servers with tool counts, skills, apps), archivedAt and updatedAt. `name` keeps those whose name holds it, ignoring case. Pass `next` back as `cursor` for the page after.",
      inputSchema: standard(Schema.Struct({ ...Page, name: Schema.optional(NonEmptyString(32)) })),
      annotations: reads,
    },
    ({ name, ...page }) =>
      reply((api) => api.personas.list({ query: { ...pageQuery(page), ...(name === undefined ? {} : { name }) } })),
  )
  server.registerTool(
    'models_list',
    {
      title: 'Models a Persona may name',
      description:
        "The models on offer now, the default first: a Persona's `model` must be one of these ids, or it is refused.",
      inputSchema: standard(Schema.Struct({})),
      annotations: reads,
    },
    () => reply((api) => api.agent.models()),
  )
  server.registerTool(
    'persona_create',
    {
      title: 'Make a Persona',
      description: 'A Persona of the key, at revision 1.',
      inputSchema: standard(CreatePersona),
      annotations: writes,
    },
    (payload) => reply((api) => api.personas.create({ payload })),
  )
  server.registerTool(
    'persona_get',
    {
      title: 'Read a Persona',
      description: "One of the key's Personas with its revisions, newest first.",
      inputSchema: standard(Schema.Struct({ id: Id })),
      annotations: reads,
    },
    ({ id }) => reply((api) => api.personas.detail({ params: { id } })),
  )
  server.registerTool(
    'persona_update',
    {
      title: 'Change a Persona',
      description: "A new revision of one of the key's Personas; `expectedRevision` must be its current one.",
      inputSchema: standard(Schema.Struct({ id: Id, change: UpdatePersona })),
      annotations: writes,
    },
    ({ id, change }) => reply((api) => api.personas.update({ params: { id }, payload: change })),
  )
}

const Since = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description: 'Only what started since this time, in epoch milliseconds; the last day without it.',
})
const Chat = ChatId.annotate({ description: "One of the key's chats (a Topic's conversation or a thread)." })
const Operation = OperationId.annotate({
  description: "An operation id: one the key sent, or one inspect_turns, inspect_flows or a details' related names.",
})

/** `inspect_details`' input: a chat with the operation it sent, or with an entry of it. */
const DetailsInput = Schema.Struct({
  chat: Chat,
  operation: Schema.optional(Operation),
  entry: Schema.optional(EntryId.annotate({ description: 'An entry id of the chat, instead of an operation.' })),
})

/**
 * `inspect_turns`, `inspect_turn` and `inspect_problems`: how the key's own chats ran (ADR 0084), content-free, as the
 * owner's inspection shows it.
 */
const runTools = (server: McpServer, reply: Reply) => {
  server.registerTool(
    'inspect_turns',
    {
      title: 'Recent turns',
      description:
        "Recent turns of the key's chats (a Persona's answers included), newest first, one line each: where it came from, how it ended, model attempts, tool calls, failures and tokens.",
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
  )
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
  )
  server.registerTool(
    'inspect_problems',
    {
      title: 'Recent problems',
      description:
        "Events of the key's chats needing attention since a time, newest first: failures, cutoffs, empty answers and coverage gaps. `all` includes expected waits and recovered attempts.",
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
  )
}

/** `inspect_flows` and `inspect_details`: how the key's chats moved and what happened behind one message (ADR 0084). */
const flowTools = (server: McpServer, reply: Reply) => {
  server.registerTool(
    'inspect_flows',
    {
      title: 'Conversation flows',
      description:
        "How the key's chats moved, newest first and content-free: sends, Persona asks and answers, thread starts. Each step names its flow, who acted, its chat and operation ids, timing and how it ended. Filter by `chat` or `flow`.",
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
  )
  server.registerTool(
    'inspect_details',
    {
      title: 'Details of one operation',
      description:
        "What happened behind one message of the key's chat: give `chat` with the `operation` that sent it, or with an `entry`. Its turn summary, steps and time when it ran a turn, every run event in order, and the operations related to it (its Personas' answers, a thread's first send).",
      inputSchema: standard(DetailsInput),
      annotations: reads,
    },
    ({ chat, operation, entry }) =>
      operation !== undefined && entry === undefined
        ? reply((api) => api.inspect.details({ params: { id: chat }, query: { operation } }))
        : entry !== undefined && operation === undefined
          ? reply((api) => api.inspect.details({ params: { id: chat }, query: { entry } }))
          : Promise.resolve(failed(new InvalidInput({ reason: 'details take an operation or an entry' }))),
  )
}

/** The key's tools over `call`. */
export const keyServer = (call: OwnerCaller): McpServer => {
  const server = new McpServer({ name: 'goblin', version: '0.1.0' }, { instructions: GUIDE })
  const reply = replyWith(call)
  topicTools(server, reply)
  conversationTools(server, reply)
  personaTools(server, reply)
  runTools(server, reply)
  flowTools(server, reply)
  return server
}
