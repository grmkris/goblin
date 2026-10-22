import type { CommitPublication, EntryRecord } from '@earendil-works/pi-durable'
import type { ConversationUpdated } from '@goblin/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import { registerChat } from '../../src/chats/directory.ts'
import { conversationId } from '../../src/pi/context.ts'
import { renewLease } from '../../src/publish/leases.ts'
import { type ChatReading, Watch, type WatchMessage, subjectOf } from '../../src/publish/watch.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { fake } from '../fake.ts'

/** A database with chat 20, a Persona's fork 25 and a subagent 26 working for it, and one lease listening. */
const setup = () => {
  const database = chatDatabase()
  const db = durable(database.db)
  registerChat(db, { chatId: '20', role: 'conversation', kind: 'thread', createdAt: 1 })
  registerChat(db, { chatId: '25', role: 'persona', kind: 'thread', parentSession: '20', createdAt: 1 })
  registerChat(db, { chatId: '26', kind: 'subagent', parentSession: '20', createdAt: 1 })
  renewLease(db, {
    id: 'lease',
    principal: 'client:c1:u1',
    name: 'conversation.updated',
    argumentsJson: '{}',
    topicId: null,
    chatId: null,
    url: 'https://hooks.example.com/a',
    secret: 'sealed',
    refreshBefore: Number.MAX_SAFE_INTEGER,
    status: 'active',
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  })
  const journal = () =>
    database.sqlite
      .prepare('SELECT chat_id AS chat, data_json AS data, at FROM app_publish_journal ORDER BY seq')
      .all()
      .map((row) => ({ chat: row['chat'], at: row['at'], ...JSON.parse(String(row['data'])) }))
  return { db, journal, close: () => database.close() }
}

/** A commit of Pi's that touched `session`'s entries. */
const commit = (session: string): CommitPublication =>
  fake<CommitPublication>({
    changes: [
      fake<CommitPublication['changes'][number]>({
        type: 'entry',
        value: fake<EntryRecord>({ conversationId: conversationId(session) }),
      }),
    ],
  })

/** What the watch's chats read as now. */
type Reading = { now: Omit<ConversationUpdated, 'chat'> }

/** The watch over `db`, reading what `state` says, its fiber running in the test's scope. */
const watching = (db: ReturnType<typeof setup>['db'], state: Reading) => {
  const read = (chat: string) =>
    Effect.succeed<ChatReading>({
      wake: { data: { chat, ...state.now }, topicId: 1 },
      fold: { last: state.now.entry, open: [] },
    })
  let ids = 0
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<WatchMessage>()
    let queued = 0
    const watch = new Watch({
      db,
      scope: yield* Effect.scope,
      queue,
      read,
      queued: Effect.sync(() => void (queued += 1)),
      newId: Effect.sync(() => `event-${(ids += 1)}`),
    })
    yield* Effect.forkScoped(watch.run)
    return { watch, queued: () => queued }
  })
}

/** Every fiber gets its turns, the clock moves `ms` on, and they get them again. */
const turns = Effect.repeat(Effect.yieldNow, { times: 20 })
const settle = (ms: number) => Effect.andThen(turns, Effect.andThen(TestClock.adjust(`${ms} millis`), turns))

describe('the watch of published Events (ADR 0112)', () => {
  it('counts a Persona fork’s and a subagent’s work for the chat they work for', () => {
    const { db, close } = setup()
    expect([subjectOf(db, '20'), subjectOf(db, '25'), subjectOf(db, '26'), subjectOf(db, '99')]).toEqual([
      '20',
      '20',
      '20',
      undefined,
    ])
    close()
  })

  it.effect('wakes after 250 ms, at most once a second, coalescing changes, and never when nothing changed', () =>
    Effect.gen(function* () {
      const { db, journal, close } = setup()
      const state: Reading = { now: { topic: null, entry: 1, activity: 'working', attention: 0 } }
      const { watch, queued } = yield* watching(db, state)
      watch.noticed(commit('25'))
      yield* settle(249)
      expect(journal()).toEqual([])
      yield* settle(1)
      expect(journal()).toEqual([expect.objectContaining({ chat: '20', entry: 1, activity: 'working', at: 250 })])
      expect(queued()).toBe(1)
      // Three commits of the chat and its subagent within the second: one wake, a second after the first.
      for (const [entry, session] of [
        [2, '20'],
        [3, '26'],
        [4, '20'],
      ] as const) {
        state.now = { ...state.now, entry }
        watch.noticed(commit(session))
        yield* settle(100)
      }
      expect(journal()).toHaveLength(1)
      yield* settle(700)
      expect(journal().map(({ entry, at }) => ({ entry, at }))).toEqual([
        { entry: 1, at: 250 },
        { entry: 4, at: 1250 },
      ])
      // A commit that changed nothing the wake says (a streamed token): nothing goes out.
      watch.noticed(commit('20'))
      yield* settle(2000)
      expect(journal()).toHaveLength(2)
      // The work ends: one wake says so.
      state.now = { ...state.now, activity: 'idle', attention: 1 }
      watch.noticed(commit('20'))
      yield* settle(250)
      expect(journal().at(-1)).toMatchObject({ entry: 4, activity: 'idle', attention: 1 })
      close()
    }),
  )

  it.effect('looks again at a chat a restart left waiting, and takes other writes’ chats', () =>
    Effect.gen(function* () {
      const { db, journal, close } = setup()
      const state: Reading = { now: { topic: null, entry: 7, activity: 'idle', attention: 0 } }
      const { watch } = yield* watching(db, state)
      yield* watch.resume(['20'])
      yield* settle(250)
      expect(journal()).toEqual([expect.objectContaining({ chat: '20', entry: 7 })])
      state.now = { ...state.now, activity: 'working' }
      yield* watch.changed(['25'])
      yield* settle(1000)
      expect(journal().at(-1)).toMatchObject({ chat: '20', activity: 'working' })
      close()
    }),
  )
})
