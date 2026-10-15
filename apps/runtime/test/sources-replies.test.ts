import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { Internal } from '../src/http/errors.ts'
import { sourceEngine } from '../src/sources/engine.ts'
import { patchSource } from '../src/sources/store.ts'
import { appSourceReplies } from '../src/storage/sources.ts'
import { PAYLOAD_SETUP, message, sourceWorld } from './sources-fixture.ts'

const OPERATION = 'source-src_00000000000000a1-m1'
const TEXT = `${'a'.repeat(80)}\n\n${'b'.repeat(80)}`
const result = (status: string, extra: Record<string, unknown> = {}) => ({
  content: [],
  isError: false,
  structuredContent: { status, ...extra },
})
const setup = { ...PAYLOAD_SETUP, newKeys: { to: 'topic' as const, topic: 4 } }
const event = { eventId: 'e1', data: message('m1') }

describe('Source reply result rules and durable progress (ADR 0072)', () => {
  it.effect('retries a failed terminal owner notice after reconstruction without replaying the tool', () =>
    Effect.gen(function* () {
      const answers = new Map([[OPERATION, { text: TEXT }]])
      const { db, engine, ports, seen, active } = yield* sourceWorld({ answers, sendResult: () => result('rejected') })
      yield* engine.takeEvent(yield* active(setup), event, ports)
      const failure = yield* Effect.flip(
        engine.deliver({ ...ports, notice: () => Effect.fail(new Internal({ reason: 'notice unavailable' })) }),
      )
      expect(failure._tag).toBe('Internal')
      expect(db.select().from(appSourceReplies).get()).toMatchObject({ outcome: 'rejected', reported: false })
      answers.clear()
      const reconstructed = yield* sourceEngine({ db, telemetry: undefined, wake: () => {} })
      yield* reconstructed.deliver(ports)
      yield* reconstructed.deliver(ports)
      expect(seen.calls).toHaveLength(1)
      expect(seen.notices).toHaveLength(1)
      expect(db.select().from(appSourceReplies).get()).toMatchObject({ outcome: 'rejected', reported: true })
    }),
  )
  it.effect('resumes only the unaccepted piece with frozen arguments after reconstruction and loss of the answer', () =>
    Effect.gen(function* () {
      const answers = new Map([[OPERATION, { text: TEXT }]])
      let attempt = 0
      const { db, engine, ports, seen, active } = yield* sourceWorld({
        answers,
        sendResult: () => result(++attempt === 2 ? 'retryable' : 'accepted'),
      })
      const source = yield* active(setup)
      yield* engine.takeEvent(source, event, ports)
      yield* engine.deliver(ports)
      expect(db.select().from(appSourceReplies).get()).toMatchObject({
        nextPiece: 1,
        attempts: 1,
        dispatching: false,
        outcome: null,
      })
      answers.clear()
      const reconstructed = yield* sourceEngine({ db, telemetry: undefined, wake: () => {} })
      yield* TestClock.adjust('1 minute')
      yield* reconstructed.deliver(ports)
      expect(seen.calls.map((call) => call.args.text)).toEqual(['a'.repeat(80), 'b'.repeat(80), 'b'.repeat(80)])
      expect(seen.calls[2]).toEqual(seen.calls[1])
      expect(db.select().from(appSourceReplies).get()).toMatchObject({ nextPiece: 2, outcome: 'accepted' })
    }),
  )

  it.effect('honors retryAt without replaying accepted pieces', () =>
    Effect.gen(function* () {
      let attempt = 0
      const { db, engine, ports, seen, active } = yield* sourceWorld({
        answers: new Map([[OPERATION, { text: TEXT }]]),
        sendResult: () => result(++attempt === 2 ? 'retryable' : 'accepted', { retryAt: 3_600_000 }),
      })
      const reply = PAYLOAD_SETUP.reply
      if (reply === undefined) return yield* Effect.die('missing fixture reply')
      const source = yield* active({
        ...setup,
        reply: {
          ...reply,
          result: {
            accepted: { pointer: '/status', equals: 'accepted' },
            retryable: { pointer: '/status', equals: 'retryable' },
            retryAt: '/retryAt',
          },
        },
      })
      yield* engine.takeEvent(source, event, ports)
      yield* engine.deliver(ports)
      expect(db.select().from(appSourceReplies).get()?.nextAt).toBe(3600)
      yield* TestClock.adjust('59 minutes')
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(2)
      yield* TestClock.adjust('1 minute')
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(3)
      expect(seen.calls[2]).toEqual(seen.calls[1])
    }),
  )

  for (const status of ['rejected', 'unknown', 'not-recognized']) {
    it.effect(`stops a ${status} structured result without automatic retry`, () =>
      Effect.gen(function* () {
        const { db, engine, ports, seen, active } = yield* sourceWorld({
          answers: new Map([[OPERATION, { text: TEXT }]]),
          sendResult: () => result(status),
        })
        yield* engine.takeEvent(yield* active(setup), event, ports)
        yield* engine.deliver(ports)
        yield* TestClock.adjust('1 hour')
        yield* engine.deliver(ports)
        expect(seen.calls).toHaveLength(1)
        expect(db.select().from(appSourceReplies).get()?.outcome).toBe(status === 'rejected' ? 'rejected' : 'unknown')
        expect(seen.notices).toHaveLength(1)
      }),
    )
  }

  it.effect('does not interpret a successful MCP envelope without result rules as acceptance', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, active } = yield* sourceWorld({
        answers: new Map([[OPERATION, { text: TEXT }]]),
      })
      const configured = PAYLOAD_SETUP.reply
      if (configured === undefined) return yield* Effect.die('missing fixture reply')
      const { result: _rules, ...reply } = configured
      yield* engine.takeEvent(yield* active({ ...setup, reply }), event, ports)
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(1)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('unknown')
    }),
  )

  it.effect('keeps transport uncertainty terminal and does not replay the call', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, state, active } = yield* sourceWorld({
        answers: new Map([[OPERATION, { text: TEXT }]]),
      })
      yield* engine.takeEvent(yield* active(setup), event, ports)
      state.failing = true
      yield* engine.deliver(ports)
      state.failing = false
      yield* TestClock.adjust('1 hour')
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(1)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('unknown')
    }),
  )

  it.effect('treats an unacknowledged durable dispatch intent as unknown after reconstruction', () =>
    Effect.gen(function* () {
      const answers = new Map([[OPERATION, { text: TEXT }]])
      const { db, engine, ports, seen, active } = yield* sourceWorld({ answers, sendResult: () => result('retryable') })
      yield* engine.takeEvent(yield* active(setup), event, ports)
      yield* engine.deliver(ports)
      db.update(appSourceReplies).set({ dispatching: true, nextAt: 0 }).run()
      answers.clear()
      const reconstructed = yield* sourceEngine({ db, telemetry: undefined, wake: () => {} })
      yield* reconstructed.deliver(ports)
      expect(seen.calls).toHaveLength(1)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('unknown')
    }),
  )

  it.effect('settles an entirely acknowledged plan after reconstruction even when the Source changed', () =>
    Effect.gen(function* () {
      const answers = new Map([[OPERATION, { text: TEXT }]])
      const { db, engine, ports, seen, active } = yield* sourceWorld({ answers })
      const source = yield* active(setup)
      yield* engine.takeEvent(source, event, ports)
      yield* engine.deliver(ports)
      db.update(appSourceReplies).set({ outcome: null, settledAt: null, reported: false }).run()
      patchSource(db, source.row.id, { revision: 99, binding: null, state: 'proposed' }, 1)
      answers.clear()
      const reconstructed = yield* sourceEngine({ db, telemetry: undefined, wake: () => {} })
      yield* reconstructed.deliver(ports)
      expect(seen.calls).toHaveLength(2)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('accepted')
    }),
  )

  it.effect('ends at the waiting deadline when retryAt is beyond it without an early retry', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, active } = yield* sourceWorld({
        answers: new Map([[OPERATION, { text: TEXT }]]),
        sendResult: () => result('retryable', { retryAt: 999_999_999 }),
      })
      const reply = PAYLOAD_SETUP.reply
      if (reply === undefined) return yield* Effect.die('missing fixture reply')
      const source = yield* active({
        ...setup,
        reply: {
          ...reply,
          result: {
            accepted: { pointer: '/status', equals: 'accepted' },
            retryable: { pointer: '/status', equals: 'retryable' },
            retryAt: '/retryAt',
          },
        },
      })
      yield* engine.takeEvent(source, event, ports)
      yield* engine.deliver(ports)
      expect(db.select().from(appSourceReplies).get()?.nextAt).toBe(86_400)
      yield* TestClock.adjust('1 day')
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(1)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('given_up')
    }),
  )

  it.effect('gives up inactive replies with an unchanged binding at the waiting deadline without dispatch', () =>
    Effect.gen(function* () {
      const { db, engine, ports, seen, active } = yield* sourceWorld({
        answers: new Map([[OPERATION, { text: TEXT }]]),
      })
      const source = yield* active(setup)
      yield* engine.takeEvent(source, event, ports)
      patchSource(db, source.row.id, { state: 'paused' }, 0)
      yield* engine.deliver(ports)
      yield* TestClock.adjust('1 day')
      yield* engine.deliver(ports)
      expect(seen.calls).toHaveLength(0)
      expect(db.select().from(appSourceReplies).get()?.outcome).toBe('given_up')
    }),
  )
})
