// The producer (docs/architecture/streams.md) over the recorded Pi batches (`fixtures/`), with Pi's watch scripted: each
// reader gets its own opening and then every batch at once, a burst of joins shares one watch, the last reader to
// leave stops the chat's watch and its children's, a reader that falls behind is let go alone, as is one connected for
// fifteen minutes, and a reader that opens mid-run still learns its run's operations.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, AgentEventStream, SnapshotEvent, WatchEnd } from '@earendil-works/pi-durable'
import { type AguiEvent, EventType, type PersonaInvocationView } from '@goblin/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import type { AppError } from '../../src/http/errors.ts'
import type { PiSessions } from '../../src/pi/sessions.ts'
import { reconcile } from '../../src/streams/agui.ts'
import { opening } from '../../src/streams/bodies.ts'
import { Producer, type ProducerMessage } from '../../src/streams/producer.ts'
import { appConversations } from '../../src/storage/schema.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { fake } from '../fake.ts'
import { checked, forkChild, replay, textOf } from './agui-check.ts'
import type { Recording, ScenarioName } from './scenarios.ts'

const fixture = (name: ScenarioName): Recording =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url).href), 'utf8'))

/** A conversation with nothing in it yet: what a reader that joined before the recorded run opened with. */
const EMPTY: SnapshotEvent = {
  type: 'snapshot',
  entries: [],
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
}

/** One of Pi's watches as the test drives it: the snapshot it began with, its listener, and whether it was stopped. */
class Watch implements AgentEventStream {
  readonly snapshot: SnapshotEvent
  stopped = false
  #listener: ((events: readonly AgentEvent[], context: never) => Promise<void>) | undefined
  readonly #ended = Promise.withResolvers<WatchEnd>()
  readonly closed = this.#ended.promise
  constructor(snapshot: SnapshotEvent) {
    this.snapshot = snapshot
  }
  start(listener: (events: readonly AgentEvent[], context: never) => Promise<void>): void {
    this.#listener = listener
  }
  async stop(): Promise<WatchEnd> {
    this.stopped = true
    const end: WatchEnd = { reason: 'stopped' }
    this.#ended.resolve(end)
    return end
  }
  /** Pi commits `events`: the batch reaches the producer as Pi's watch hands it over. */
  deliver(events: readonly AgentEvent[]): Promise<void> {
    // SAFETY: the producer's listener reads only the events; Pi's context is not part of what it follows.
    return this.#listener?.(events, undefined as never) ?? Promise.resolve()
  }
}

/** Every watch Pi opened, by session, in order; `snapshots` says what the next watch of a session begins with. */
class ScriptedPi {
  readonly watches = new Map<string, Watch[]>()
  readonly snapshots = new Map<string, SnapshotEvent>()
  readonly sessions = fake<PiSessions['Service']>({
    events: (session) =>
      Effect.sync(() => {
        const watch = new Watch(this.snapshots.get(session) ?? EMPTY)
        this.watches.set(session, [...(this.watches.get(session) ?? []), watch])
        return watch
      }),
  })
  /** The newest watch of `session`. */
  watch(session: string): Watch {
    const watch = this.watches.get(session)?.at(-1)
    if (watch === undefined) throw new Error(`no watch of ${session}`)
    return watch
  }
}

/** Whether an event is anything but a change of STATE. */
const notState = ({ type }: AguiEvent): boolean => type !== EventType.STATE_DELTA

/** Lets the producer's fiber take everything offered to it so far. */
const settle = Effect.repeat(Effect.yieldNow, { times: 200 })

type Reader = {
  readonly row: number
  readonly sink: Queue.Queue<readonly AguiEvent[], Cause.Done>
  readonly joined: Deferred.Deferred<void, AppError>
  /** Whether the producer let it go, ending its connection. */
  readonly released: { value: boolean }
}

/** A producer over chat `1` (Pi session `1`) and its own database, its fiber running in the test's scope. */
function producer(
  options: { readonly working?: readonly PersonaInvocationView[]; readonly operations?: Map<number, string> } = {},
) {
  return Effect.gen(function* () {
    const { db, close } = chatDatabase()
    yield* Effect.addFinalizer(() => Effect.sync(close))
    db.insert(appConversations)
      .values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 })
      .run()
    const pi = new ScriptedPi()
    const asked: number[][] = []
    const queue = yield* Queue.unbounded<ProducerMessage>()
    const produce = new Producer({
      db: durable(db),
      pi: pi.sessions,
      scope: yield* Effect.scope,
      queue,
      queued: () => Effect.succeed(new Map()),
      operations: (inputs) =>
        Effect.sync(() => {
          asked.push([...inputs])
          return options.operations ?? new Map()
        }),
      personas: {
        working: (chat) => Effect.succeed(chat === '1' ? (options.working ?? []) : []),
        invocation: () => Effect.succeed(undefined),
        persona: () => Effect.succeed({ name: 'Squarewave', avatar: { glyph: 'S', hue: 210 } }),
        promptEntry: () => Effect.succeed(undefined),
      },
    })
    let rows = 0
    /** A reader of chat `1` joins with a sink of `capacity` batches; the fiber has not taken it yet. */
    const join = (capacity = 512) =>
      Effect.gen(function* () {
        rows += 1
        const reader: Reader = {
          row: rows,
          sink: yield* Queue.bounded<readonly AguiEvent[], Cause.Done>(capacity),
          joined: yield* Deferred.make<void, AppError>(),
          released: { value: false },
        }
        const { row, sink, joined: done, released } = reader
        const release = () => void (released.value = true)
        yield* Queue.offer(queue, { kind: 'join', chat: '1', row, sink, done, release })
        return reader
      })
    const leave = (reader: Reader) => Queue.offer(queue, { kind: 'leave', chat: '1', row: reader.row })
    const start = Effect.andThen(Effect.forkScoped(produce.run), settle)
    return { pi, join, leave, start, asked }
  })
}

/** Everything in the reader's sink so far, as one list of events. */
const taken = (reader: Reader) => Effect.map(Queue.clear(reader.sink), (batches) => batches.flat())

/** Each batch handed to Pi's newest watch of session `1`, in turn, the producer settled after each. */
const deliver = (pi: ScriptedPi, batches: readonly (readonly AgentEvent[])[]) =>
  Effect.forEach(
    batches,
    (batch) =>
      Effect.andThen(
        Effect.promise(() => pi.watch('1').deliver(batch)),
        settle,
      ),
    {
      discard: true,
    },
  )

describe("the producer of a chat's stream", () => {
  it.effect('opens a reader that joins mid-answer on its own, and the first reader reads on as if alone', () =>
    Effect.gen(function* () {
      const recording = fixture('overflow')
      const { mid, batches } = recording
      if (mid === undefined) throw new Error('the overflow fixture has no mid-answer snapshot')
      const { pi, join, start } = yield* producer()
      const first = yield* join()
      yield* start
      yield* Deferred.await(first.joined)
      // Pi's watch hands over the run up to the snapshot the second reader's watch will begin with.
      yield* deliver(pi, batches.slice(0, mid.after))
      pi.snapshots.set('1', mid.snapshot)
      const second = yield* join()
      yield* settle
      yield* Deferred.await(second.joined)
      yield* deliver(pi, batches.slice(mid.after))
      // The first reader reads the golden run, and the second watch's snapshot caught it up on STATE alone.
      const alone = opening('1', EMPTY)
      const before = replay(alone.cursor, batches.slice(0, mid.after))
      const caught = reconcile(before.cursor, mid.snapshot)
      const after = replay(caught.cursor, batches.slice(mid.after))
      const read = yield* taken(first)
      expect(read).toEqual(checked([...alone.events, ...before.events, ...caught.events, ...after.events]))
      expect(caught.events.map(({ type }) => type)).toEqual([EventType.STATE_DELTA])
      const golden = replay(alone.cursor, batches).events
      expect(read.filter(notState)).toEqual([...alone.events, ...golden].filter(notState))
      const late = checked(yield* taken(second))
      expect(late.slice(0, 2).map(({ type }) => type)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.STATE_SNAPSHOT])
      const [reply] = late.flatMap((event) => (event.type === EventType.TEXT_MESSAGE_START ? [event.messageId] : []))
      expect(textOf(late, reply ?? '')).toBe('One two three four')
      expect(late.filter(notState).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } })
      // The first watch stopped when the second began: one watch follows the chat at a time.
      expect(pi.watches.get('1')?.map(({ stopped }) => stopped)).toEqual([true, false])
    }),
  )

  it.effect('opens a burst of readers from one watch of the chat', () =>
    Effect.gen(function* () {
      const { pi, join, start } = yield* producer()
      const readers = [yield* join(), yield* join(), yield* join()]
      yield* start
      for (const reader of readers) yield* Deferred.await(reader.joined)
      expect(pi.watches.get('1')).toHaveLength(1)
      for (const reader of readers)
        expect((yield* taken(reader)).map(({ type }) => type)).toEqual([
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
        ])
    }),
  )

  it.effect("stops the chat's watch and its children's when the last reader leaves", () =>
    Effect.gen(function* () {
      const recording = fixture('fork')
      const kid = recording.child
      if (kid === undefined) throw new Error('the fork fixture has no child')
      const child = forkChild(kid.chat)
      const working: PersonaInvocationView = {
        operationId: 'op-fork',
        persona: 4,
        revision: 2,
        chat: '1',
        order: 0,
        state: 'running',
        fork: kid.chat,
        createdAt: 0,
      }
      const { pi, join, leave, start } = yield* producer({ working: [working] })
      pi.snapshots.set(kid.chat, kid.start)
      const one = yield* join()
      const other = yield* join()
      yield* start
      yield* Deferred.await(one.joined)
      const opened = yield* taken(one)
      expect(opened.find(({ type }) => type === EventType.SUBAGENT_STARTED)).toMatchObject({
        subagentRunId: kid.chat,
        name: child.name,
      })
      yield* leave(one)
      yield* settle
      expect(pi.watch('1').stopped).toBe(false)
      expect(pi.watch(kid.chat).stopped).toBe(false)
      yield* leave(other)
      yield* settle
      expect(pi.watch('1').stopped).toBe(true)
      expect(pi.watch(kid.chat).stopped).toBe(true)
      // A reader that joins again finds the chat afresh: a new watch, its child followed again.
      const again = yield* join()
      yield* settle
      yield* Deferred.await(again.joined)
      expect(pi.watches.get('1')).toHaveLength(2)
      expect(pi.watch(kid.chat).stopped).toBe(false)
    }),
  )

  it.effect('lets go of a reader whose sink is full, and only that one', () =>
    Effect.gen(function* () {
      const { batches } = fixture('plain')
      const { pi, join, start } = yield* producer()
      const slow = yield* join(1)
      const fast = yield* join()
      yield* start
      yield* deliver(pi, batches)
      // The slow reader keeps its opening, then its connection ends; the other reads every batch.
      expect((yield* Queue.take(slow.sink)).map(({ type }) => type)).toEqual([
        EventType.MESSAGES_SNAPSHOT,
        EventType.STATE_SNAPSHOT,
      ])
      expect(Exit.isFailure(yield* Effect.exit(Queue.take(slow.sink)))).toBe(true)
      expect([slow.released.value, fast.released.value]).toEqual([true, false])
      const all = checked(yield* taken(fast))
      expect(all.filter(notState).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
      expect(pi.watch('1').stopped).toBe(false)
    }),
  )

  it.effect('lets go of a reader connected for fifteen minutes, its connection ended, and only that one', () =>
    Effect.gen(function* () {
      const { join, start } = yield* producer()
      const early = yield* join()
      yield* start
      yield* TestClock.adjust('10 minutes')
      const late = yield* join()
      yield* settle
      yield* Deferred.await(late.joined)
      yield* TestClock.adjust('5 minutes')
      yield* settle
      expect([early.released.value, late.released.value]).toEqual([true, false])
      yield* taken(early)
      expect(Exit.isFailure(yield* Effect.exit(Queue.take(early.sink)))).toBe(true)
      yield* TestClock.adjust('10 minutes')
      yield* settle
      expect(late.released.value).toBe(true)
    }),
  )

  it.effect('names the operations of the run in flight to a reader that opens mid-run', () =>
    Effect.gen(function* () {
      const { mid } = fixture('overflow')
      if (mid === undefined) throw new Error('the overflow fixture has no mid-answer snapshot')
      const { pi, join, start, asked } = yield* producer({ operations: new Map([[8, 'op-overflow']]) })
      pi.snapshots.set('1', mid.snapshot)
      const reader = yield* join()
      yield* start
      yield* Deferred.await(reader.joined)
      const [started] = (yield* taken(reader)).filter(({ type }) => type === EventType.RUN_STARTED)
      expect(started).toMatchObject({ runId: '1:8', metadata: { goblin: { operations: ['op-overflow'] } } })
      expect(asked).toEqual([[8]])
    }),
  )

  it.effect('refuses a reader past the readers a chat takes, as stream_busy', () =>
    Effect.gen(function* () {
      const { join, start } = yield* producer()
      const readers: Reader[] = []
      for (let index = 0; index < 33; index += 1) readers.push(yield* join())
      yield* start
      const answers = yield* Effect.forEach(readers, (reader) => Effect.exit(Deferred.await(reader.joined)))
      expect(answers.filter(Exit.isSuccess)).toHaveLength(32)
      const refused = answers.find(Exit.isFailure)
      expect(refused === undefined ? undefined : Cause.squash(refused.cause)).toMatchObject({
        _tag: 'Conflict',
        reason: 'stream_busy',
      })
    }),
  )
})
