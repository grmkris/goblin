// The Sources' ports over the agent's services (ADR 0066): a tool of a Source's connection called for the agent under
// the owner's grants, the owner's messages as turns in their Topic (sources/turns.ts, as a Source's), how each turn
// ended, notices to the owner framed as untrusted data from the connection, a message's attachments kept in the owner's
// files (ADR 0065), and a Topic made for a new conversation.
import type { ContentBlock } from '@modelcontextprotocol/client'
import { PERSONAL_TOPIC } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { ChatOperations, Chats } from '../chats/service.ts'
import { Conversations } from '../chats/service.ts'
import type { Files } from '../files/service.ts'
import { UpstreamMcp } from '../http/errors.ts'
import { materialize } from '../mcp/content/materialize.ts'
import { McpConnections, McpServers } from '../mcp/service.ts'
import type { McpToolResult } from '../mcp/connections/types.ts'
import { Models } from '../models.ts'
import { Notices } from '../notices/service.ts'
import { reportAndRecover } from '../observability/report.ts'
import type { Invocations, Personas } from '../personas/service.ts'
import type { KeptAttachments } from '../pi/content.ts'
import type { PiSessions } from '../pi/sessions.ts'
import { writeNotice } from '../routines/notices.ts'
import type { Changes } from '../runtime/changes.ts'
import type { AgentInput } from '../runtime/input.ts'
import { sourceTopicFor } from './places.ts'
import type { SourceNotice, SourcePorts } from './types.ts'
import { type TurnOrigin, answerOf, keepTurn, submitTurn } from './turns.ts'

/** What making a Topic for a conversation reads: the Topics, their receipts and flows. */
type TopicServices = Effect.Services<ReturnType<typeof sourceTopicFor>>

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
  | Files
  | Models
  | TopicServices

/** A Source's turn as it is recorded: through an MCP server, as the owner's own message (ADR 0066), marked so. */
const SOURCE: TurnOrigin = {
  receipt: { kind: 'source', origin: 'source' },
  flow: { flow: 'source', via: 'mcp' },
  persona: { via: 'mcp' },
  note: 'app.source',
  own: 'source',
}

const Kept = { uri: Schema.String, mimeType: Schema.optionalKey(Schema.String) }

/**
 * The attachments a Source keeps, read as the MCP content blocks they are: a link, an image or audio with its bytes, or
 * an embedded resource's text or blob. Anything else is not one.
 */
const Attached = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('resource_link'),
    name: Schema.String,
    title: Schema.optionalKey(Schema.String),
    ...Kept,
  }),
  Schema.Struct({ type: Schema.Literal('image'), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({ type: Schema.Literal('audio'), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('resource'),
    resource: Schema.Union([
      Schema.Struct({ ...Kept, text: Schema.String }),
      Schema.Struct({ ...Kept, blob: Schema.String }),
    ]),
  }),
])
const decodeAttachment = Schema.decodeUnknownOption(Attached)

/**
 * An attachment as `materialize` keeps it: an image's bytes as an embedded blob (named `image`), so it is kept as a
 * file like the rest; any other block as it came.
 */
const keptBlock = (block: typeof Attached.Type): ContentBlock =>
  block.type === 'image'
    ? { type: 'resource', resource: { uri: 'image', mimeType: block.mimeType, blob: block.data } }
    : block

/** Whether the owner's model takes images (`Models`); a deployment that cannot tell says no. */
const ownerSeesImages = Effect.gen(function* () {
  const { current, options } = yield* (yield* Models).choice
  return options.some((option) => option.id === current && option.images)
}).pipe(
  // expected: with no model on offer, a kept image is named by its file only.
  Effect.orElseSucceed(() => false),
)

/**
 * A message's attachments kept in the owner's files (ADR 0065): each block `materialize` keeps (a link fetched or read,
 * an image, audio or embedded bytes), a note for each one it could not keep, and one for blocks that are not MCP content.
 */
const receive = (connectionId: string, blocks: readonly unknown[]) =>
  Effect.gen(function* () {
    const read = blocks.map((block) => Option.getOrUndefined(decodeAttachment(block)))
    const content = read.flatMap((block) => (block === undefined ? [] : [keptBlock(block)]))
    const unread = read.length - content.length
    const kept = yield* materialize(connectionId, { content }, { images: ownerSeesImages, text: 'file' })
    const received = [...kept.values()]
    const skipped = content.length - kept.size
    return {
      connectionId,
      files: received.flatMap((each) => (each.kind === 'file' ? [each.file] : [])),
      notes: [
        ...received.flatMap((each) =>
          each.kind !== 'note' ? [] : [each.link === undefined ? each.note : `${each.note} (${each.link.uri})`],
        ),
        ...(unread === 0 ? [] : [`could not read ${String(unread)} of its attachments: not MCP content`]),
        ...(skipped === 0 ? [] : [`could not keep ${String(skipped)} of its attachments: not a file`]),
      ],
      images: received.flatMap((each) => (each.kind === 'file' && each.image !== undefined ? [each.image] : [])),
    } satisfies KeptAttachments
  }).pipe(
    reportAndRecover('sources.receive', {
      connectionId,
      files: [],
      notes: ['could not keep the attachments: receiving failed'],
      images: [],
    }),
  )

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
  send: (connectionId, tool, args, authorize) =>
    Effect.provideContext(
      McpConnections.use((connections) =>
        connections.callTool(connectionId, tool, args, { caller: 'model', authorize }),
      ),
      context,
    ),
  submit: (turn, persona) => Effect.provideContext(submitTurn(SOURCE, turn, persona), context),
  keep: (turn) => Effect.provideContext(keepTurn(SOURCE, turn), context),
  answer: (reply) => Effect.provideContext(answerOf(SOURCE, reply), context),
  notice: (notice) => Effect.provideContext(postNotice(notice), context),
  label: (connectionId) => Effect.provideContext(labelOf(connectionId), context),
  receive: (connectionId, blocks) => Effect.provideContext(receive(connectionId, blocks), context),
  // goblin makes it for the setup the owner confirmed (`newKeys: topic-per-key`).
  topic: (name, fallback, operationId) => Effect.provideContext(sourceTopicFor(name, operationId, fallback), context),
}))
