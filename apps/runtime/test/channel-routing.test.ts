import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { type Answer, type ChannelPorts, type Turn, telegramChannel } from '../src/channel/channel.ts'
import { routeRow, seeChat } from '../src/channel/routes.ts'
import { enableEvents, pendingReplies } from '../src/channel/store.ts'
import { type ChannelCall, TelegramRefused } from '../src/channel/tools.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const GROUP = 'g_trip0000000000000'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

type Entry = Record<string, unknown> & { readonly id: string }

/**
 * A channel carried by Events on SQLite that reads every chat (`reach: all`), an inbox that answers `entries` once, and
 * ports that record what each message became: a turn (with the Persona that answers it) or a note kept in a Topic.
 */
const fixture = (answers: ReadonlyMap<string, Answer> = new Map(), refuse?: string) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const sqlite = durable(db)
    const channel = yield* telegramChannel({ db: sqlite, telemetry: undefined, wake: () => undefined })
    enableEvents(sqlite, 'mygram', 'c0', 1, { reach: 'all' })
    const inbox: Entry[] = []
    const calls: { readonly tool: string; readonly args: Record<string, unknown> }[] = []
    const call: ChannelCall = (tool, args) =>
      Effect.gen(function* () {
        calls.push({ tool, args })
        if (tool === 'inbox') {
          const messages = inbox.splice(0)
          return { messages, nextCursor: `c${String(calls.length)}` }
        }
        if (refuse !== undefined) return yield* new TelegramRefused({ connectionId: 'mygram', code: refuse })
        return { ok: true }
      })
    const turns: { readonly turn: Turn; readonly persona?: number }[] = []
    const kept: Turn[] = []
    const ports: ChannelPorts = {
      call,
      submit: (turn, persona) =>
        Effect.sync(() => {
          turns.push(persona === undefined ? { turn } : { turn, persona })
          return { chatId: String(turn.topic * 10), ...(persona === undefined ? {} : { persona }) }
        }),
      keep: (turn) => Effect.sync(() => void kept.push(turn)),
      answer: ({ operationId }) => Effect.succeed(answers.get(operationId)),
    }
    const pull = (...entries: Entry[]) =>
      Effect.andThen(
        Effect.sync(() => inbox.push(...entries)),
        channel.pull(ports, 2),
      )
    return { db: sqlite, channel, ports, calls, turns, kept, pull }
  })

const message = (id: string, extra: Record<string, unknown> = {}): Entry => ({
  id,
  text: `text of ${id}`,
  direction: 'in',
  ...extra,
})

describe('routing Telegram chats to Topics', () => {
  it.effect('reads every chat in one stream and answers a DM entry with or without a chat in Personal', () =>
    Effect.gen(function* () {
      const { calls, turns, pull } = yield* fixture()
      yield* pull(message('m1'), message('m2', { chat: 'dm', threadId: null, sender: null, trigger: null }))
      expect(calls.slice(0, 2)).toEqual([
        { tool: 'chats', args: {} },
        { tool: 'inbox', args: { chat: 'all', cursor: 'c0', limit: 100 } },
      ])
      expect(turns.map(({ turn }) => [turn.topic, turn.operationId, turn.author])).toEqual([
        [1, 'telegram-m1', 'Telegram'],
        [1, 'telegram-m2', 'Telegram'],
      ])
    }),
  )

  it.effect('holds a new group until the owner routes it, then delivers what it held in order to that Topic', () =>
    Effect.gen(function* () {
      const { db, channel, ports, turns, pull } = yield* fixture()
      yield* pull(message('g1', { chat: GROUP, trigger: 'mention' }), message('g2', { chat: GROUP, trigger: 'reply' }))
      expect(turns).toEqual([])
      expect(routeRow(db, GROUP, 0)).toMatchObject({ status: 'pending', title: 'Telegram group' })
      seeChat(db, { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup' }, 2)
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 4 }, 'owner', 3)
      expect(turns.map(({ turn }) => [turn.topic, turn.operationId, turn.author])).toEqual([
        [4, 'telegram-g1', 'Telegram · Trip planning'],
        [4, 'telegram-g2', 'Telegram · Trip planning'],
      ])
      expect(pendingReplies(db).map(({ tgChat, tgThread, chatId }) => [tgChat, tgThread, chatId])).toEqual([
        [GROUP, 0, '40'],
        [GROUP, 0, '40'],
      ])
      yield* pull(message('g3', { chat: GROUP }))
      expect(turns).toHaveLength(3)
    }),
  )

  it.effect('lets a Persona answer, keeps a listened message as a note, and drops an ignored one', () =>
    Effect.gen(function* () {
      const { db, channel, ports, turns, kept, pull } = yield* fixture()
      yield* pull(message('a0', { chat: GROUP }), message('b0', { chat: 'g_book0000', threadId: 0 }))
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 2, persona: 7 }, 'owner', 3)
      yield* channel.route(ports, { chat: 'g_book0000', thread: 0 }, { mode: 'listen', topic: 5 }, 'agent', 3)
      expect(turns).toEqual([expect.objectContaining({ persona: 7 })])
      expect(kept.map(({ topic, operationId }) => [topic, operationId])).toEqual([[5, 'telegram-b0']])
      expect(pendingReplies(db)).toEqual([expect.objectContaining({ operationId: 'telegram-a0', personaId: 7 })])
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'ignore' }, 'owner', 4)
      yield* pull(message('a1', { chat: GROUP }))
      expect(turns).toHaveLength(1)
    }),
  )

  it.effect("routes a forum topic by its chat's route until it has its own, and skips what is not the owner's", () =>
    Effect.gen(function* () {
      const { db, channel, ports, turns, pull } = yield* fixture()
      seeChat(db, { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup', isForum: true }, 1)
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 4 }, 'owner', 1)
      yield* pull(
        message('t1', { chat: GROUP, threadId: 9 }),
        message('out', { chat: GROUP, direction: 'out' }),
        message('old', { chat: GROUP, delivery: 'archive' }),
        message('raw', { chat: '-100123' }),
      )
      expect(turns.map(({ turn }) => [turn.topic, turn.author])).toEqual([[4, 'Telegram · Trip planning / Topic 9']])
      yield* channel.route(ports, { chat: GROUP, thread: 9 }, { mode: 'answer', topic: 6 }, 'owner', 2)
      yield* pull(message('t2', { chat: GROUP, threadId: 9 }))
      expect(turns.at(-1)?.turn.topic).toBe(6)
    }),
  )

  it.effect('answers in the chat and topic a message came from, and as buttons when it stopped on one choice', () =>
    Effect.gen(function* () {
      const answers = new Map<string, Answer>([
        ['telegram-t1', { text: 'Booked.' }],
        [
          'telegram-t2',
          {
            text: '',
            question: {
              prompt: 'Window or aisle?',
              options: [
                { id: 'w', label: 'Window' },
                { id: 'a', label: 'Aisle' },
              ],
            },
          },
        ],
      ])
      const { db, channel, ports, calls, pull } = yield* fixture(answers)
      seeChat(db, { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup' }, 1)
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 4 }, 'owner', 1)
      yield* pull(message('t1', { chat: GROUP, threadId: 9 }), message('t2', { chat: GROUP }))
      expect(yield* channel.deliver(ports, 3)).toBe(false)
      const sent = calls
        .filter(({ tool }) => tool === 'send' || tool === 'ask')
        .map(({ tool, args }) => ({ tool, ...args }))
      expect(sent).toEqual([
        { tool: 'send', operationId: 'reply-0-telegram-t1', text: 'Booked.', chat: GROUP, threadId: 9 },
        {
          tool: 'ask',
          operationId: 'reply-ask-telegram-t2',
          question: 'Window or aisle?',
          mode: 'choice',
          options: [
            { id: 'w', label: 'Window' },
            { id: 'a', label: 'Aisle' },
          ],
          waitMs: 0,
          chat: GROUP,
        },
      ])
      expect(pendingReplies(db)).toEqual([])
    }),
  )

  it.effect('gives up an answer for a chat the bot was removed from, and marks the chat paused', () =>
    Effect.gen(function* () {
      const answers = new Map<string, Answer>([['telegram-p1', { text: 'Too late.' }]])
      const { db, channel, ports, pull } = yield* fixture(answers, 'chat_paused')
      seeChat(db, { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup' }, 1)
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 4 }, 'owner', 1)
      yield* pull(message('p1', { chat: GROUP }))
      yield* channel.deliver(ports, 3)
      expect(routeRow(db, GROUP, 0)?.status).toBe('paused')
      expect(pendingReplies(db)).toEqual([])
    }),
  )
})
