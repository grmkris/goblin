import type { CallerScope } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { endpointScopes } from '../http/api/context.ts'
import { AppError, toAppError } from '../http/errors.ts'
import type { OwnerClient } from './client.ts'

/** Each Standard Schema `standard` made, by the schema it came from, so a tool's input can be widened (ADR 0097). */
const sources = new WeakMap<object, Schema.Top>()

/** A schema as the MCP SDK's Standard Schema with JSON Schema, for a tool's input or output. */
export const standard = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const made = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
  sources.set(made, schema)
  return made
}

/** The schema a tool's input was made from by `standard`, when it was. */
export const sourceOf = (input: object): Schema.Top | undefined => sources.get(input)

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

/**
 * One typed owner API call as the caller, to the workspace a call names (ADR 0097; none for a caller that reaches
 * one): its value, or a rejection with the agent's `AppError`.
 */
export type OwnerCaller = <A>(
  call: (api: OwnerClient) => Effect.Effect<A, unknown>,
  workspace: string | undefined,
) => Promise<A>

/** The workspace the tool call being started names, which its `reply` takes as the call starts. */
export interface CallTarget {
  current: string | undefined
}

/**
 * Each tool, by the endpoint it calls (`<group>.<endpoint>`).
 *
 * @internal The parity test holds it to the endpoints annotated `EndpointScope`, one to one, but `STREAMED`.
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
  setup_catalog: 'setup.catalog',
  server_list: 'mcp.servers',
  source_list: 'sources.list',
  source_routes: 'sources.routes',
  routine_list: 'routines.list',
  routine_runs: 'routines.runs',
  routine_propose: 'routines.propose',
  routine_edit: 'routines.edit',
  routine_archive: 'routines.archive',
  routine_pause: 'routines.pause',
} as const
export type ToolName = keyof typeof TOOLS

/**
 * The scoped endpoints no tool calls: a chat's stream (ADR 0110), server-sent events a caller reads over HTTP with its
 * own credential, which a tool's one answer cannot carry.
 *
 * @internal The parity test leaves these out of the tools it expects.
 */
export const STREAMED: ReadonlySet<string> = new Set(['conversations.stream'])

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

/** One call's answer as the tool's result, or the agent's refusal as its error result, in the call's workspace. */
export const replyWith =
  (call: OwnerCaller, target: CallTarget) =>
  async <A>(run: (api: OwnerClient) => Effect.Effect<A, unknown>) => {
    // Read before the first await: the call that started this reply names its workspace only while it starts.
    const workspace = target.current
    try {
      return text(await call(run, workspace))
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
