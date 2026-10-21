import type { CallerScope } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { endpointScopes } from '../http/api/context.ts'
import { AppError, toAppError } from '../http/errors.ts'
import type { OwnerClient } from './client.ts'

/** A schema as the MCP SDK's Standard Schema with JSON Schema, for a tool's input or output. */
export const standard = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

/** A result as one JSON text block, and as structured content when it is an object, which the goblin CLI renders. */
export const text = (value: unknown) => {
  const content = [{ type: 'text' as const, text: JSON.stringify(value) }]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { content, structuredContent: { ...value } }
    : { content }
}

const encodeError = Schema.encodeSync(AppError)

/** A failure as the tool's result: the error's tag and fields, never a stack or a foreign message. */
export const failed = (cause: unknown) => ({ isError: true, ...text(encodeError(toAppError(cause))) })

/** One typed owner API call as the caller: its value, or a rejection with the agent's `AppError`. */
export type OwnerCaller = <A>(call: (api: OwnerClient) => Effect.Effect<A, unknown>) => Promise<A>

/**
 * Each tool, by the endpoint it calls (`<group>.<endpoint>`).
 *
 * @internal The parity test holds it to the endpoints annotated `EndpointScope`, one to one.
 */
export const TOOLS = {
  ask_agent: 'agent.ask',
  get_recent_messages: 'agent.recent',
  topic_list: 'topics.list',
  topic_get: 'topics.get',
  topic_create: 'topics.create',
  topic_update: 'topics.update',
  topic_set_setup: 'topics.setSetup',
  conversation_update: 'conversations.update',
  conversation_send: 'conversations.submit',
  thread_start: 'conversations.startThread',
  conversation_entries: 'conversations.entries',
  conversation_stop: 'conversations.stop',
  persona_list: 'personas.list',
  models_list: 'agent.models',
  persona_create: 'personas.create',
  persona_get: 'personas.detail',
  persona_update: 'personas.update',
  inspect_conversations: 'inspect.conversations',
  inspect_conversation: 'inspect.conversation',
  inspect_turns: 'inspect.turns',
  inspect_turn: 'inspect.turn',
  inspect_problems: 'inspect.problems',
  inspect_flows: 'inspect.flows',
  inspect_details: 'inspect.details',
} as const
export type ToolName = keyof typeof TOOLS

/** The scope each tool's endpoint names, from its contract alone. */
const SCOPES = endpointScopes(OwnerApi)

/** Registers a tool when the caller holds its endpoint's scope; a caller never sees a tool it could not call. */
export type Add = (name: ToolName, register: () => void) => void
export const adder =
  (scopes: readonly CallerScope[]): Add =>
  (name, register) => {
    const scope = SCOPES.get(TOOLS[name])
    if (scope !== undefined && scopes.includes(scope)) register()
  }

/** One call's answer as the tool's result, or the agent's refusal as its error result. */
export const replyWith =
  (call: OwnerCaller) =>
  async <A>(run: (api: OwnerClient) => Effect.Effect<A, unknown>) => {
    try {
      return text(await call(run))
    } catch (cause) {
      // expected: the failure is the tool's error result, its tag and safe fields only (tools.ts).
      return failed(cause)
    }
  }
export type Reply = ReturnType<typeof replyWith>

export const writes = { readOnlyHint: false, openWorldHint: false } as const
export const reads = { readOnlyHint: true, openWorldHint: false } as const

/** Any page size a tool takes: 1 to 100. */
export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
