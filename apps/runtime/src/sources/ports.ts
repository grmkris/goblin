// The Sources' ports over the agent's services (ADR 0066): a tool of a Source's connection called for the agent under
// the owner's grants, the owner's messages as turns in their Topic (sources/turns.ts, as a Source's), how each turn
// ended, and notices to the owner framed as untrusted data from the connection.
import { PERSONAL_TOPIC } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { ChatOperations, Chats } from '../chats/service.ts'
import { Conversations } from '../chats/service.ts'
import { UpstreamMcp } from '../http/errors.ts'
import { McpConnections, McpServers } from '../mcp/service.ts'
import type { McpToolResult } from '../mcp/types.ts'
import { Notices } from '../notices/service.ts'
import type { Invocations, Personas } from '../personas/service.ts'
import type { PiSessions } from '../pi/sessions.ts'
import { writeNotice } from '../routines/notices.ts'
import type { Changes } from '../runtime/changes.ts'
import type { AgentInput } from '../runtime/input.ts'
import type { SourceNotice, SourcePorts } from './types.ts'
import { type TurnOrigin, answerOf, keepTurn, submitTurn } from './turns.ts'

/** What the ports' programs read, captured once when the ports are made. */
export type PortServices =
  | Chats
  | ChatOperations
  | Conversations
  | PiSessions
  | Personas
  | Invocations
  | AgentInput
  | McpConnections
  | McpServers
  | Notices
  | Changes

/** A Source's turn as it is recorded: through an MCP server, as the owner's own message (ADR 0066). */
const SOURCE: TurnOrigin = {
  receipt: { kind: 'source', origin: 'source' },
  flow: { flow: 'source', via: 'mcp' },
  persona: { via: 'mcp' },
  note: 'app.source',
}

const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })
const decodeText = Schema.decodeUnknownOption(TextBlock)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * A tool's answer as a Source reads it: its structured content, else the JSON its first text block holds (a server
 * that answers in text only); nothing otherwise.
 */
const resultOf = (result: McpToolResult): unknown =>
  result.structuredContent ??
  Option.getOrUndefined(Option.flatMap(decodeText(result.content?.[0]), (block) => decodeJson(block.text)))

/** A tool of `connectionId` called for the agent itself: the owner's exact grant applies, and Ask first refuses it. */
const callTool = (connectionId: string, tool: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const result = yield* (yield* McpConnections).callTool(connectionId, tool, args, { caller: 'model' })
    if (result.isError === true) return yield* new UpstreamMcp({ connectionId, reason: 'remote-rpc' })
    return resultOf(result)
  })

/**
 * A notice to the owner in `notice.topic`'s Conversation (Personal's while it is archived or gone), kept once by its id
 * and counted into its Source's hour (twenty an hour; the rest are kept for Activity only). The model reads it framed
 * as untrusted data from the connection.
 */
const postNotice = (notice: SourceNotice) =>
  Effect.gen(function* () {
    const home = yield* (yield* Conversations).routineHome(notice.topic ?? PERSONAL_TOPIC)
    const now = yield* Clock.currentTimeMillis
    const claim = yield* (yield* Notices).claim(
      {
        id: notice.id,
        routineId: `source:${notice.sourceId}`,
        source: 'event',
        chatId: home.chat,
        entryRequestId: notice.id,
        connectionId: notice.connectionId,
        label: notice.label,
        title: notice.title,
        body: notice.body ?? null,
        url: null,
        at: now,
        createdAt: now,
      },
      true,
    )
    if (claim.posted) yield* writeNotice(notice.id)
  })

/** The connection's label: the owner's own name for it, its id when it has none. */
const labelOf = (connectionId: string) =>
  Effect.map(
    McpServers.use((servers) => servers.labels()),
    (labels) => labels.get(connectionId) ?? connectionId,
  )

/** The Sources' ports over the agent's services, captured once. */
export const sourcePorts = Effect.map(Effect.context<PortServices>(), (context): SourcePorts => ({
  call: (connectionId, tool, args) => Effect.provideContext(callTool(connectionId, tool, args), context),
  submit: (turn, persona) => Effect.provideContext(submitTurn(SOURCE, turn, persona), context),
  keep: (turn) => Effect.provideContext(keepTurn(SOURCE, turn), context),
  answer: (reply) => Effect.provideContext(answerOf(SOURCE, reply), context),
  notice: (notice) => Effect.provideContext(postNotice(notice), context),
  label: (connectionId) => Effect.provideContext(labelOf(connectionId), context),
}))
