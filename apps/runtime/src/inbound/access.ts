import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
  inputRequired,
} from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { ERROR_COPY } from '@goblin/contracts/api'
import * as Predicate from 'effect/Predicate'

/**
 * A refusal for want of access (`AccessInsufficient`, ADR 0114) as a client that can open a link is offered it: URL
 * elicitation of the widening page, once per call, on the 2026-07-28 protocol's input-required round. Ported from
 * grmkris/myapps `packages/mcp/src/elicitation.ts` at b8014322 (MIT, same author): goblin reads the client's
 * capabilities and earlier answers from the SDK's request context itself, and builds the request with the SDK's own
 * `inputRequired`.
 */

/**
 * What one call's request says of the client: its capabilities, the answers to an earlier round's asks, and whether
 * it follows tasks (it declared the Tasks extension, ADR 0119).
 */
export interface CallContext {
  readonly capabilities: ClientCapabilities | undefined
  readonly inputResponses: Readonly<Record<string, unknown>> | undefined
  readonly dropped: readonly string[]
  readonly tasks: boolean
}

/** The Tasks extension (SEP-2663), which a 2026-07-28 client declares on each request it may get a task for. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

/** The input key the widening ask goes under. */
const KEY = 'access'

/**
 * What goblin reads of a client's capabilities: whether it declares URL elicitation. The SDK validates a modern
 * request's envelope before it dispatches; its neutral type drops this key, so goblin checks the part it reads.
 */
const isCapabilities = (value: unknown): value is ClientCapabilities =>
  Schema.is(Schema.Struct({ elicitation: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.Unknown) })) }))(
    value,
  )
/** A request's input responses: a record of the client's answers, each read as untrusted. */
const isResponses = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** A record's field, when `value` is a record that has it. */
const field = (value: unknown, name: string): unknown =>
  Predicate.isObject(value) && Predicate.hasProperty(value, name) ? value[name] : undefined

/**
 * The call context a handler's request carries (the SDK's `ctx.mcpReq`): the client's capabilities from the request's
 * envelope, which only a 2026-07-28 request has, its input responses, and whether those capabilities declare the Tasks
 * extension (read from the envelope as sent: the SDK's capability type keeps no extensions).
 */
export const callContextOf = (ctx: unknown): CallContext => {
  const request = field(ctx, 'mcpReq')
  const capabilities = field(field(request, 'envelope'), CLIENT_CAPABILITIES_META_KEY)
  const responses = field(request, 'inputResponses')
  const dropped = field(request, 'droppedInputResponseKeys')
  return {
    capabilities: isCapabilities(capabilities) ? capabilities : undefined,
    inputResponses: isResponses(responses) ? responses : undefined,
    dropped: Array.isArray(dropped) ? dropped.filter(Predicate.isString) : [],
    tasks: Predicate.isObject(field(field(capabilities, 'extensions'), TASKS_EXTENSION)),
  }
}

/** Whether an earlier round's answer to `key` came back: accepted, declined or cancelled. */
const answered = (responses: Readonly<Record<string, unknown>> | undefined, key: string): boolean => {
  const action = field(responses?.[key], 'action')
  return action === 'accept' || action === 'decline' || action === 'cancel'
}

/**
 * The URL elicitation of `widenUrl` for a call refused for want of access, when the client declared URL elicitation and
 * has not answered it for this call yet; `null` keeps the plain refusal (an answered or dropped ask, or a client that
 * cannot open one).
 */
export const accessElicitation = (context: CallContext | undefined, widenUrl: string): InputRequiredResult | null => {
  if (
    context?.capabilities?.elicitation?.url === undefined ||
    answered(context.inputResponses, KEY) ||
    context.dropped.includes(KEY)
  )
    return null
  const message = `${ERROR_COPY.AccessInsufficient.message} ${ERROR_COPY.AccessInsufficient.recovery}`
  return inputRequired({ inputRequests: { [KEY]: inputRequired.elicitUrl({ message, url: widenUrl }) } })
}
