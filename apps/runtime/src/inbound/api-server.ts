import {
  ChatId,
  CreatePersona,
  CreateTopic,
  SendMessage,
  StartThread,
  StopConversation,
  TopicSetupEdit,
  UpdatePersona,
  UpdateTopic,
} from '@goblin/contracts'
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
  topic_create: 'topics.create',
  topic_update: 'topics.update',
  topic_set_setup: 'topics.setSetup',
  conversation_send: 'conversations.submit',
  thread_start: 'conversations.startThread',
  conversation_entries: 'conversations.entries',
  conversation_stop: 'conversations.stop',
  persona_create: 'personas.create',
  persona_get: 'personas.detail',
  persona_update: 'personas.update',
} as const

const Id = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const After = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const GUIDE =
  "goblin for a server's API key: the key makes and uses its own Topics, their chats and its own Personas, never the owner's. Setups name only the MCP servers on the key, tool by tool. Send with conversation_send or thread_start, then read replies with conversation_entries after the cursor it last returned."

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

/** `topic_create`, `topic_update` and `topic_set_setup`. */
const topicTools = (server: McpServer, reply: Reply) => {
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

/** `persona_create`, `persona_get` and `persona_update`. */
const personaTools = (server: McpServer, reply: Reply) => {
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

/** The key's tools over `call`. */
export const keyServer = (call: OwnerCaller): McpServer => {
  const server = new McpServer({ name: 'goblin', version: '0.1.0' }, { instructions: GUIDE })
  const reply = replyWith(call)
  topicTools(server, reply)
  conversationTools(server, reply)
  personaTools(server, reply)
  return server
}
