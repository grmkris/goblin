import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { type ChannelPorts, telegramChannel } from '../src/channel/channel.ts'
import type { Turn } from '../src/sources/turns.ts'
import { tapOf } from '../src/channel/offers.ts'
import { heldOf, routeRow } from '../src/channel/routes.ts'
import { enableEvents, setNewChats } from '../src/channel/store.ts'
import type { ChannelCall } from '../src/channel/tools.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const GROUP = 'g_trip0000000000000'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

type Entry = Record<string, unknown> & { readonly id: string }

/**
 * A channel that reads every chat, whose server lists "Trip planning" (a forum with topic 9, "Flights"), answers each
 * question with the id `q<n>` and keeps how the owner answered it (`pressed`); ports that record turns and the Topics
 * "New topic" made.
 */
const fixture = Effect.gen(function* () {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  const sqlite = durable(db)
  const channel = yield* telegramChannel({ db: sqlite, telemetry: undefined, wake: () => undefined })
  enableEvents(sqlite, 'mygram', 'c0', 1, { reach: 'all' })
  const inbox: Entry[] = []
  const asked: Record<string, unknown>[] = []
  const pressed = new Map<string, { readonly choice?: string; readonly answer?: string }>()
  let questions = 0
  const call: ChannelCall = (tool, args) =>
    Effect.sync(() => {
      const questionId = args['questionId']
      if (tool === 'inbox' && typeof questionId === 'string') {
        const answered = pressed.get(questionId)
        return {
          messages: [],
          nextCursor: 'c1',
          question: answered === undefined ? { status: 'pending' } : { status: 'answered', ...answered },
        }
      }
      if (tool === 'inbox') return { messages: inbox.splice(0), nextCursor: 'c1' }
      if (tool === 'chats')
        return {
          chats: [
            { chat: 'dm', title: 'Kris', kind: 'private', status: 'active' },
            { chat: GROUP, title: 'Trip planning', kind: 'supergroup', status: 'active', isForum: true },
          ],
        }
      if (tool === 'threads') return { threads: [{ threadId: 9, name: 'Flights', createdAt: 0 }] }
      if (tool === 'ask') {
        asked.push(args)
        questions += 1
        return { status: 'pending', id: `q${String(questions)}` }
      }
      return { status: 'sent' }
    })
  const turns: Turn[] = []
  const topics: string[] = []
  const ports: ChannelPorts = {
    call,
    submit: (turn) =>
      Effect.sync(() => {
        turns.push(turn)
        return { chatId: String(turn.topic) }
      }),
    keep: () => Effect.void,
    topic: (title, operationId) =>
      Effect.sync(() => {
        topics.push(`${title} ${operationId}`)
        return 7
      }),
    answer: () => Effect.succeed(undefined),
  }
  const pull = (...entries: Entry[]) =>
    Effect.andThen(
      Effect.sync(() => inbox.push(...entries)),
      channel.pull(ports, 2),
    )
  return { db: sqlite, channel, ports, asked, pressed, turns, topics, pull }
})

const message = (id: string, extra: Record<string, unknown> = {}): Entry => ({
  id,
  text: `text of ${id}`,
  direction: 'in',
  ...extra,
})

describe("goblin's offers about new Telegram chats", () => {
  it.effect(
    'asks once in the DM about a new group, holds its messages, and routes them by the button the owner pressed',
    () =>
      Effect.gen(function* () {
        const { db, asked, pressed, turns, topics, pull } = yield* fixture
        yield* pull(message('g1', { chat: GROUP, trigger: 'mention' }), message('g2', { chat: GROUP }))
        expect(asked).toEqual([
          {
            operationId: `telegram-offer:${GROUP}:0`,
            question: 'I was added to <b>Trip planning</b>. Where should it go?',
            mode: 'choice',
            options: [
              { id: 'topic', label: 'New topic #Trip planning' },
              { id: 'personal', label: 'Personal' },
              { id: 'ignore', label: 'Ignore' },
            ],
            chat: 'dm',
            waitMs: 0,
          },
        ])
        expect(turns).toEqual([])
        expect(heldOf(db, GROUP)).toHaveLength(2)
        // The server keeps the pressed button; the entry's words are display text, worded however mygram likes.
        pressed.set('q1', { choice: 'topic' })
        yield* pull(
          message('answer:q1', {
            chat: 'dm',
            trigger: 'answer',
            questionId: 'q1',
            text: 'Question q1: Anna tapped "personal" (Personal).',
            replyToOperationId: `telegram-offer:${GROUP}:0`,
          }),
        )
        expect(topics).toEqual([`Trip planning telegram:${GROUP}:0`])
        expect(turns.map(({ topic, operationId }) => [topic, operationId])).toEqual([
          [7, 'telegram-g1'],
          [7, 'telegram-g2'],
        ])
        expect(routeRow(db, GROUP, 0)).toMatchObject({ status: 'routed', mode: 'answer', topicId: 7, offer: 'closed' })
        yield* pull(message('late', { chat: 'dm', trigger: 'answer', questionId: 'q1', text: 'Personal' }))
        expect(turns).toHaveLength(2)
      }),
  )

  it.effect('routes a new chat at once by the default, with no question', () =>
    Effect.gen(function* () {
      const { db, asked, turns, pull } = yield* fixture
      setNewChats(db, 'personal')
      yield* pull(message('g1', { chat: GROUP }))
      expect(asked).toEqual([])
      expect(turns.map(({ topic }) => topic)).toEqual([1])
    }),
  )

  it.effect('lets a new forum topic follow its chat at once, and asks once whether it should go elsewhere', () =>
    Effect.gen(function* () {
      const { db, channel, ports, asked, turns, pull } = yield* fixture
      yield* channel.sync(ports, 1)
      yield* channel.route(ports, { chat: GROUP, thread: 0 }, { mode: 'answer', topic: 4 }, 'owner', 1)
      asked.splice(0)
      yield* pull(message('t1', { chat: GROUP, threadId: 12 }))
      expect(turns.map(({ topic }) => topic)).toEqual([4])
      expect(asked).toEqual([
        expect.objectContaining({
          operationId: `telegram-offer:${GROUP}:12`,
          options: [
            { id: 'topic', label: 'New topic #Topic 12' },
            { id: 'inherit', label: 'Same as the chat' },
            { id: 'ignore', label: 'Ignore' },
          ],
        }),
      ])
      // The owner typed a button's words instead of pressing it: the question is still open on the server.
      yield* pull(message('answer:q', { chat: 'dm', questionId: routeRow(db, GROUP, 12)?.questionId, text: 'Ignore' }))
      yield* pull(message('t2', { chat: GROUP, threadId: 12 }))
      expect(turns).toHaveLength(1)
    }),
  )

  it("reads the choice and the label of mygram's display line for a tap, for a question goblin did not keep", () => {
    expect(tapOf('Question q1: Anna tapped "w" (Window).')).toEqual({ choice: 'w', label: 'Window' })
    expect(tapOf('Question q1: You tapped "a \\"b\\"" (A (b)).')).toEqual({ choice: 'a "b"', label: 'A (b)' })
    expect(tapOf('just words')).toBeUndefined()
  })
})
