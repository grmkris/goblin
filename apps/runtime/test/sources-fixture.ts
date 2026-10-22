import type { SourceSetup } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import type { EventDescriptor } from '../src/mcp/events/protocol.ts'
import type { McpToolResult } from '../src/mcp/connections/types.ts'
import { loaded, sourceEngine } from '../src/sources/engine.ts'
import type { SourceNotice, SourcePorts } from '../src/sources/types.ts'
import { patchSource, propose } from '../src/sources/store.ts'
import type { Answer, Turn } from '../src/sources/turns.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * A chat server's `message.received`, as a producer of the draft Events profile describes it (the shape of
 * `mcp/events-fixture.ts`): each event carries one message with its chat, its forum thread, who sent it and its words.
 */
export const MESSAGE_RECEIVED: EventDescriptor = {
  name: 'message.received',
  inputSchema: { type: 'object', properties: { chat: { type: 'string' } } },
  payloadSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      chat: { type: 'string' },
      threadId: { type: ['integer', 'null'] },
      text: { type: 'string' },
      from: { type: 'object', properties: { isOwner: { type: 'boolean' }, name: { type: 'string' } } },
    },
  },
  delivery: ['poll', 'webhook'],
}

/** The inbox tool the same server reads from a cursor, with the output schema it declares. */
export const INBOX_READ = {
  name: 'inbox_read',
  outputSchema: {
    type: 'object' as const,
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            chat: { type: 'string' },
            threadId: { type: ['integer', 'null'] },
            text: { type: 'string' },
            direction: { type: 'string' },
            from: { type: 'object', properties: { isOwner: { type: 'boolean' } } },
          },
        },
      },
      nextCursor: { type: 'string' },
    },
  },
}

/** A Source read from each event's data: the owner speaks when `/from/isOwner` is true; answers go back by chat. */
export const PAYLOAD_SETUP: SourceSetup = {
  wake: { event: 'message.received', arguments: { chat: 'all' } },
  key: [
    { name: 'chat', pointer: '/chat' },
    { name: 'thread', pointer: '/threadId' },
  ],
  speaksForMe: { pointer: '/from/isOwner', equals: true },
  others: 'notice',
  read: { from: 'payload', id: '/id', text: '/text' },
  reply: {
    tool: 'message_send',
    arguments: { chat: '{{key.chat}}', threadId: '{{key.thread}}', text: '{{text}}', operationId: '{{operationId}}' },
    maxChars: 100,
    result: {
      accepted: { pointer: '/status', equals: 'accepted' },
      retryable: { pointer: '/status', equals: 'retryable' },
      rejected: { pointer: '/status', equals: 'rejected' },
    },
  },
  newKeys: { to: 'held' },
}

/** One message as the server's event carries it. */
export const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  chat: 'dm',
  threadId: null,
  text: `text of ${id}`,
  from: { isOwner: true, name: 'Owner' },
  ...extra,
})

/** What the fake ports saw: each tool call, turn (with its Persona), note kept, notice, attachments and Topic made. */
export type Seen = {
  readonly calls: { readonly tool: string; readonly args: Record<string, unknown> }[]
  readonly turns: { readonly turn: Turn; readonly persona?: number }[]
  readonly kept: Turn[]
  readonly notices: SourceNotice[]
  readonly received: { readonly connectionId: string; readonly blocks: readonly unknown[] }[]
  readonly topics: { readonly name: string; readonly fallback: string; readonly operationId: string }[]
}

/** The file the fake ports keep for each attachment, by its place in the message's list. */
export const keptFile = (index: number) => ({
  path: `/agent/received/chat/2026-10-15/photo-${String(index)}.png`,
  name: `photo-${String(index)}.png`,
  size: 68,
  mimeType: 'image/png',
})

/** The Topic the fake ports make for a new conversation. */
export const NEW_TOPIC = 9

/**
 * The Sources' engine on real SQLite with fake ports: a tool call answers `answer(tool, args)` (failing while `failing`
 * holds), a turn goes to chat `<topic>0`, and each turn's answer is whatever `answers` holds for its operation.
 */
export const sourceWorld = (
  options: {
    readonly answer?: (tool: string, args: Record<string, unknown>) => unknown
    readonly sendResult?: (args: Record<string, unknown>) => McpToolResult
    readonly answers?: ReadonlyMap<string, Answer>
  } = {},
) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const sqlite = durable(db)
    const woken: number[] = []
    const engine = yield* sourceEngine({
      db: sqlite,
      telemetry: undefined,
      wake: (seconds) => void woken.push(seconds),
    })
    const seen: Seen = { calls: [], turns: [], kept: [], notices: [], received: [], topics: [] }
    const state = { failing: false }
    const ports: SourcePorts = {
      call: (connectionId, tool, args) =>
        Effect.suspend(() => {
          seen.calls.push({ tool, args })
          if (state.failing) return Effect.fail(new UpstreamMcp({ connectionId, reason: 'transport' }))
          return Effect.succeed(options.answer?.(tool, args) ?? { ok: true })
        }),
      send: (connectionId, tool, args, authorize) =>
        Effect.gen(function* () {
          yield* authorize
          seen.calls.push({ tool, args })
          if (state.failing) return yield* new UpstreamMcp({ connectionId, reason: 'transport' })
          return (
            options.sendResult?.(args) ?? { isError: false, content: [], structuredContent: { status: 'accepted' } }
          )
        }),
      submit: (turn, persona) =>
        Effect.sync(() => {
          seen.turns.push(persona === undefined ? { turn } : { turn, persona })
          return { chatId: `${String(turn.topic)}0`, ...(persona === undefined ? {} : { persona }) }
        }),
      keep: (turn) => Effect.sync(() => void seen.kept.push(turn)),
      answer: ({ operationId }) => Effect.succeed(options.answers?.get(operationId)),
      notice: (notice) => Effect.sync(() => void seen.notices.push(notice)),
      label: () => Effect.succeed('Chat'),
      receive: (connectionId, blocks) =>
        Effect.sync(() => {
          seen.received.push({ connectionId, blocks })
          return {
            connectionId,
            files: blocks.map((_, index) => keptFile(index)),
            notes: [],
            images: blocks.map(() => ({ data: 'aGk=', mimeType: 'image/png' })),
          }
        }),
      topic: (name, fallback, operationId) =>
        Effect.sync(() => {
          seen.topics.push({ name, fallback, operationId })
          return NEW_TOPIC
        }),
    }
    /** A Source with `setup` on connection `chat`, confirmed and bound at binding 7. */
    const active = (setup: SourceSetup = PAYLOAD_SETUP, id = 'src_00000000000000a1') =>
      Effect.gen(function* () {
        propose(
          sqlite,
          {
            id,
            operationId: `op-${id}`,
            connectionId: 'chat',
            title: 'Chat',
            chatId: null,
            setup,
          },
          1,
        )
        const row = patchSource(
          sqlite,
          id,
          { state: 'active', binding: 7, endpoint: 'https://chat.example/mcp', grantVersion: 'v1', confirmedAt: 0 },
          1,
        )
        if (row === undefined) return yield* Effect.die('no source row')
        return yield* loaded(row)
      })
    return { db: sqlite, engine, ports, seen, state, woken, active }
  })
