import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach } from 'vitest'
import { type AppError, Forbidden, ResidentInactive, UpstreamMcp } from '../../src/http/errors.ts'
import { noticesOf } from '../../src/layers/routines.ts'
import { McpConnections, Resident } from '../../src/mcp/service.ts'
import type { McpCallOptions, McpToolResult } from '../../src/mcp/types.ts'
import { deliverNoticeCopies } from '../../src/notices/copies.ts'
import { Notices } from '../../src/notices/service.ts'
import { NoticeStore } from '../../src/notices/store.ts'
import { Db } from '../../src/runtime/db.ts'
import { appNotices } from '../../src/storage/notices.ts'
import { appNotifySink } from '../../src/storage/sources.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { stub } from '../http/api/fixture.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

/** The owner's own chat on a messaging server, with the words and the operation id as whole values. */
const SINK = { chat: 'dm', text: '{{text}}', operationId: '{{operationId}}' }

/** What one call through the sink answers: the server's result, or a failure. */
type Answer = McpToolResult | AppError

/**
 * The copies over real notices on SQLite, Notify me via on connection `chat`, resident authority while `resident.on`,
 * and a server whose tool runs the host's last-moment check (`authorize`) and then answers from `answers` in turn (the
 * last one again after that); `beforeCheck` runs between the call's start and that check.
 */
const world = () => {
  const database = chatDatabase()
  open.push(database)
  const db = durable(database.db)
  const notices = new NoticeStore(db)
  const resident = { on: true }
  const calls: { readonly connectionId: string; readonly tool: string; readonly args: Record<string, unknown> }[] = []
  const answers: Answer[] = [{ content: [], structuredContent: { id: 'remote-1', delivery: 'accepted', extra: 1 } }]
  const hooks: { beforeCheck: () => void } = { beforeCheck: () => undefined }
  const setSink = (connectionId: string, args: unknown, updatedAt: number) => {
    const row = { id: 1, connectionId, tool: 'message_send', arguments: JSON.stringify(args), updatedAt }
    db.insert(appNotifySink).values(row).onConflictDoUpdate({ target: appNotifySink.id, set: row }).run()
  }
  setSink('chat', SINK, 1)
  const services = Layer.mergeAll(
    Layer.succeed(Notices, noticesOf(notices)),
    Layer.succeed(Db, db),
    stub(Resident, {
      require: () => (resident.on ? Effect.void : Effect.fail(new ResidentInactive({ state: 'revoked' }))),
    }),
    stub(McpConnections, {
      callTool: (connectionId: string, tool: string, args: Record<string, unknown>, options?: McpCallOptions) =>
        Effect.gen(function* () {
          hooks.beforeCheck()
          yield* options?.authorize ?? Effect.void
          calls.push({ connectionId, tool, args })
          const answer = (answers.length > 1 ? answers.shift() : answers[0]) ?? { content: [] }
          if ('content' in answer) return answer
          return yield* Effect.fail(answer)
        }),
    }),
  )
  /** A written notice of routine `id`, from `connectionId`, with a copy saying `Sidequest: Picked <safe>`. */
  const notice = (id: string, connectionId: string | null = 'sidequest') =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Effect.sync(() => {
        notices.claim(
          {
            id,
            routineId: `rt_${id}`,
            source: 'event',
            chatId: '1',
            entryRequestId: id,
            connectionId,
            label: 'Sidequest',
            title: 'Picked <safe>',
            body: null,
            url: null,
            at,
            createdAt: at,
            copyText: 'Sidequest: Picked <safe>',
          },
          true,
        )
        notices.written(id, at)
      }),
    )
  const deliver = deliverNoticeCopies.pipe(Effect.provide(services))
  return { db, notices, resident, calls, answers, hooks, setSink, notice, deliver }
}

describe("a notice's copy through Notify me via (ADR 0070)", () => {
  it.effect(
    'fills the sink with the frozen words, unescaped, and a stable operation id, once, keeping the receipt',
    () =>
      Effect.gen(function* () {
        const { notices, calls, notice, deliver } = world()
        yield* notice('n1')
        expect(yield* deliver).toBe(true)
        expect(yield* deliver).toBe(false)
        expect(calls).toEqual([
          {
            connectionId: 'chat',
            tool: 'message_send',
            args: {
              chat: 'dm',
              text: 'Sidequest: Picked <safe>',
              operationId: expect.stringMatching(/^notice-[\da-f]{32}$/u),
            },
          },
        ])
        const row = notices.get('n1')
        expect(row).toMatchObject({ copyState: 'accepted', copyAttempts: 1, copySink: expect.stringMatching(/^1:/u) })
        expect(JSON.parse(row?.copyReceipt ?? '{}')).toEqual({
          operationId: calls[0]?.args['operationId'],
          id: 'remote-1',
          delivery: 'accepted',
        })
      }),
  )

  it.effect('tries a failed call again with backoff, the same bytes each time, and gives up after five tries', () =>
    Effect.gen(function* () {
      const { notices, calls, answers, notice, deliver } = world()
      answers.splice(0, answers.length, new UpstreamMcp({ connectionId: 'chat', reason: 'timeout' }))
      yield* notice('n1')
      yield* deliver
      expect(notices.get('n1')).toMatchObject({ copyState: 'pending', copyAttempts: 1, copyNextAt: 30_000 })
      // Not due before its backoff.
      yield* deliver
      expect(calls).toHaveLength(1)
      for (const wait of [30, 60, 120, 240]) {
        yield* TestClock.adjust(wait * 1000)
        yield* deliver
      }
      expect(calls).toHaveLength(5)
      expect(new Set(calls.map((call) => JSON.stringify(call.args))).size).toBe(1)
      expect(notices.get('n1')).toMatchObject({ copyState: 'failed', copyAttempts: 5, copyReceipt: null })
      expect(yield* deliver).toBe(false)
    }),
  )

  it.effect('gives up without a call on a copy fifteen minutes old', () =>
    Effect.gen(function* () {
      const { notices, calls, notice, deliver } = world()
      yield* notice('n1')
      yield* TestClock.adjust('15 minutes')
      yield* deliver
      expect(calls).toEqual([])
      expect(notices.get('n1')?.copyState).toBe('failed')
    }),
  )

  it.effect('goes only to the sink its first attempt went to: a sink changed or cleared since suppresses it', () =>
    Effect.gen(function* () {
      const { db, notices, calls, answers, setSink, notice, deliver } = world()
      answers.unshift(new UpstreamMcp({ connectionId: 'chat', reason: 'timeout' }))
      yield* notice('changed')
      yield* deliver
      // The owner saves Notify me via again, the same tool with other arguments.
      setSink('chat', { ...SINK, chat: 'group' }, 1)
      yield* TestClock.adjust('30 seconds')
      yield* deliver
      expect(calls).toHaveLength(1)
      expect(notices.get('changed')).toMatchObject({ copyState: 'suppressed', copyAttempts: 2 })
      yield* notice('cleared')
      db.delete(appNotifySink).run()
      yield* deliver
      expect(calls).toHaveLength(1)
      expect(notices.get('cleared')?.copyState).toBe('suppressed')
    }),
  )

  it.effect("suppresses a copy on lost authority, a tool that may not send, a refusal, or the sink's own event", () =>
    Effect.gen(function* () {
      const { db, notices, resident, calls, answers, notice, deliver } = world()
      resident.on = false
      yield* notice('lapsed')
      yield* deliver
      resident.on = true
      answers.splice(0, answers.length, new Forbidden({ reason: 'Owner approval required for this exact call' }))
      yield* notice('ask-first')
      yield* deliver
      answers.splice(0, answers.length, { content: [], isError: true })
      yield* notice('refused')
      yield* deliver
      yield* notice('echo', 'chat')
      yield* deliver
      const states = db.select({ id: appNotices.id, state: appNotices.copyState }).from(appNotices).all()
      expect(Object.fromEntries(states.map((row) => [row.id, row.state]))).toEqual({
        lapsed: 'suppressed',
        'ask-first': 'suppressed',
        refused: 'suppressed',
        echo: 'suppressed',
      })
      // Only the tool that may not send and the one that refused were reached; nothing left for the others.
      expect(calls).toHaveLength(2)
      expect(notices.get('echo')?.copyAttempts).toBe(1)
    }),
  )

  it.effect('checks authority and the sink again right before the call leaves', () =>
    Effect.gen(function* () {
      const { db, notices, calls, hooks, notice, deliver } = world()
      hooks.beforeCheck = () => void db.update(appNotifySink).set({ updatedAt: 2 }).where(eq(appNotifySink.id, 1)).run()
      yield* notice('n1')
      yield* deliver
      expect(calls).toEqual([])
      expect(notices.get('n1')?.copyState).toBe('suppressed')
    }),
  )
})
