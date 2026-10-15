// The Telegram channel's server tools (ADRs 0009, 0052, 0055): which names they have on the connection that carries the
// channel, a call of one as an Effect, and what a refusal of one says. Which names those tools have (`inbox_read`, or
// mysi's `mygram_inbox_read`) is decided in one place, `telegramTools` in the contracts.
import { type TelegramTool, telegramTools } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type AppError, InvalidInput, UpstreamMcp } from '../http/errors.ts'
import type { McpConnections } from '../mcp/service.ts'
import type { McpToolResult } from '../mcp/connections/types.ts'

/** The tools a server without Events must offer as well, to ring the doorbell; granted when the owner turns it on. */
export const DOORBELL_TOOLS = ['subscribe', 'unsubscribe'] as const
type DoorbellTool = (typeof DOORBELL_TOOLS)[number]

/**
 * A channel tool refused the call with a reason of its own (mygram's `{ error: { code } }`, or an access refusal with
 * the URL that widens the grant): `chat_paused`, `chat_left`, `access_insufficient`, …. Never content.
 */
export class TelegramRefused extends Schema.TaggedError<TelegramRefused>()('TelegramRefused', {
  connectionId: Schema.String,
  code: Schema.String,
  widenUrl: Schema.optional(Schema.String),
}) {}

/**
 * A tool of the channel server as an Effect (`channelTool`), by what it does. Its structured result; an error result
 * fails, as `TelegramRefused` when the server said why.
 */
export type ChannelCall = (
  tool: TelegramTool | DoorbellTool,
  args: Record<string, unknown>,
) => Effect.Effect<unknown, AppError | TelegramRefused>

/**
 * The name `tool` has on `connectionId`, from the tools its connection lists: mygram's own, or mysi's `mygram_` one. The
 * doorbell's tools are only ever bare. Fails when the server no longer offers the channel's tools.
 */
export const channelToolName = (
  connections: typeof McpConnections.Service,
  connectionId: string,
  tool: TelegramTool | DoorbellTool,
) =>
  Effect.gen(function* () {
    if (tool === 'subscribe' || tool === 'unsubscribe') return tool
    const snapshot = yield* connections.connect(connectionId, { use: 'background' })
    const names = telegramTools(snapshot.tools.map(({ name }) => name))
    if (names === undefined)
      return yield* new InvalidInput({ reason: `${connectionId} no longer offers Telegram's inbox and send tools` })
    return names[tool]
  })

const Refusal = Schema.Struct({ code: Schema.String, widenUrl: Schema.optional(Schema.String) })
const Refused = Schema.Union([Refusal, Schema.Struct({ error: Refusal })])
const RefusedText = Schema.fromJsonString(Refused)
const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })

/**
 * What an error result says about why: the code and widen URL of mygram's refusal, as structured content or as the JSON
 * text of its first block (a refusal never carries structured content to an older client). None when it says nothing.
 */
export function refusalOf(result: McpToolResult): { readonly code: string; readonly widenUrl?: string } | undefined {
  const structured = Schema.decodeUnknownOption(Refused)(result.structuredContent)
  const text = Schema.decodeUnknownOption(TextBlock)(result.content?.[0]).pipe(
    Option.flatMap((block) => Schema.decodeUnknownOption(RefusedText)(block.text)),
  )
  const found = Option.getOrUndefined(Option.orElse(structured, () => text))
  if (found === undefined) return undefined
  const refusal = 'error' in found ? found.error : found
  return { code: refusal.code.slice(0, 64), ...(refusal.widenUrl === undefined ? {} : { widenUrl: refusal.widenUrl }) }
}

/**
 * A tool of the channel server through the MCP connections, called for the agent itself: the owner's exact grant
 * applies as for any call of the model. Its structured result; an error result fails, with the server's reason when it
 * gave one.
 */
export const channelTool = (connections: typeof McpConnections.Service, connectionId: string): ChannelCall =>
  Effect.fn('Channel.tool')(function* (tool: TelegramTool | DoorbellTool, args: Record<string, unknown>) {
    const name = yield* channelToolName(connections, connectionId, tool)
    const result = yield* connections.callTool(connectionId, name, args, { caller: 'model' })
    if (result.isError === true) {
      const refusal = refusalOf(result)
      if (refusal === undefined) return yield* new UpstreamMcp({ connectionId, reason: 'remote-rpc' })
      return yield* new TelegramRefused({ connectionId, ...refusal })
    }
    return result.structuredContent
  })

/** A refusal as the owner API and the agent's programs take a failure: the server's own answer, as `UpstreamMcp`. */
export const refusedAsUpstream = <A, E, R>(
  effect: Effect.Effect<A, E | TelegramRefused, R>,
): Effect.Effect<A, E | UpstreamMcp, R> =>
  Effect.mapError(effect, (error) =>
    error instanceof TelegramRefused
      ? new UpstreamMcp({ connectionId: error.connectionId, reason: 'remote-rpc' })
      : error,
  )
