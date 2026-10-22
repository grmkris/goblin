import type { StreamTier } from '@goblin/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import { chatSession } from '../chats/directory.ts'
import { type AppError, Conflict, Internal, attempt, toAppError } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { storedCursor } from '../streams/bodies.ts'
import { keyParts, outbox } from '../streams/outbox.ts'
import { Producer, type ProducerMessage } from '../streams/producer.ts'
import { Streams } from '../streams/service.ts'
import { allStreams, forgetStreams, pendingWrites, streamKey, streamsOf, unsentStreams } from '../streams/store.ts'
import { type StreamsFetch, eraseStream, streamExists, streamPath, streamsFetchOf } from '../streams/writer.ts'

/** How long a join waits for its epoch's stream to exist before it answers `stream_starting`. */
const CREATE_WAIT = '5 seconds'

/** Without the streams binding no chat streams: a join is refused, and erasing forgets the rows alone. */
const off = (forget: () => void) =>
  Streams.of({
    join: () => Effect.fail(new Conflict({ reason: 'streams_off' })),
    erase: Effect.sync(forget),
  })

/** A fixture's rotation threshold, when it sets one (`STREAM_ROTATE_BYTES`). */
const rotateBytesOf = (value: string | undefined): number | undefined => {
  const bytes = Number(value)
  return value === undefined || !Number.isSafeInteger(bytes) || bytes < 1 ? undefined : bytes
}

/**
 * The chat streams (docs/architecture/streams.md): the producer's fiber and the outbox's drains in the runtime's scope,
 * Pi's commits noticed from the start, every chat with streams known, every write not yet acknowledged sent again, and
 * every chat whose streams saw a run in flight caught up.
 */
export const StreamsLive = Layer.effect(
  Streams,
  Effect.gen(function* () {
    const { env, workspaceId, streamsFetch } = yield* AgentInput
    const db = yield* Db
    const fetchStream: StreamsFetch | undefined =
      streamsFetch ?? (env.STREAMS === undefined ? undefined : streamsFetchOf(env.STREAMS))
    if (fetchStream === undefined) return off(() => forgetStreams(db))
    const pi = yield* PiSessions
    const scope = yield* Effect.scope
    const queue = yield* Queue.unbounded<ProducerMessage>()
    const out = outbox({
      db,
      fetchStream,
      workspaceId,
      flights: yield* SingleFlight,
      scope,
      lost: (key, epoch) => Effect.asVoid(Queue.offer(queue, { kind: 'lost', ...keyParts(key), epoch })),
    })
    const produce = new Producer({
      db,
      pi,
      scope,
      queue,
      drain: out.request,
      rotateBytes: rotateBytesOf(env.STREAM_ROTATE_BYTES),
    })
    yield* Effect.forkScoped(produce.run)
    yield* start(produce, pi, queue).pipe(reportAndRecover('streams.start', undefined))
    for (const key of unsentStreams(db)) yield* out.request(key)

    /** Whether the epoch's stream is still waiting to be made. */
    const creating = (key: string, epoch: number) =>
      pendingWrites(db, key).some((write) => write.epoch === epoch && write.seq < 0)
    /** Waits until the epoch's stream is made, draining it meanwhile. */
    const created = (key: string, epoch: number) =>
      Effect.gen(function* () {
        while (creating(key, epoch)) {
          yield* out.drain(key)
          if (creating(key, epoch)) yield* Effect.sleep('100 millis')
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: CREATE_WAIT,
          orElse: () => Effect.fail(new Conflict({ reason: 'stream_starting' })),
        }),
      )
    /** A stream that expired or was erased behind the row's back: the producer moves it to a new epoch first. */
    const checkGone = (chat: string, tier: StreamTier) =>
      Effect.gen(function* () {
        const known = streamsOf(db, chat).find((each) => each.tier === tier)
        if (known === undefined || creating(streamKey(chat, tier), known.epoch)) return
        const there = yield* attempt(() => streamExists(fetchStream, streamPath(workspaceId, chat, tier, known.epoch)))
        if (there === 'no') yield* Queue.offer(queue, { kind: 'lost', chat, tier, epoch: known.epoch })
      })
    const join = Effect.fn('Streams.join')(function* (chat: string, tier: StreamTier) {
      yield* checkGone(chat, tier)
      const done = yield* Deferred.make<number, AppError>()
      yield* Queue.offer(queue, { kind: 'join', chat, tier, done })
      const epoch = yield* Deferred.await(done)
      yield* created(streamKey(chat, tier), epoch)
      return epoch
    })
    const erase = Effect.gen(function* () {
      for (const stream of allStreams(db))
        for (let epoch = 1; epoch <= stream.epoch; epoch += 1) {
          const path = streamPath(workspaceId, stream.chat, stream.tier, epoch)
          if (!(yield* attempt(() => eraseStream(fetchStream, path))))
            return yield* new Internal({ reason: 'stream_erase' })
        }
      yield* Effect.sync(() => forgetStreams(db))
    }).pipe(Effect.withSpan('Streams.erase'))
    return Streams.of({ join, erase })
  }),
)

/**
 * Pi's commits from now on, and the chats with streams: each is known by its session, and one whose streams saw a run
 * in flight is caught up at once (the run went on, or ended, while the agent was away).
 */
const start = (produce: Producer, pi: PiSessions['Service'], queue: Queue.Queue<ProducerMessage>) =>
  Effect.gen(function* () {
    const harness = yield* pi.pi.pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
    const unsubscribe = harness.subscribeCommits((publication) => produce.noticed(publication))
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    const db = yield* Db
    for (const stream of allStreams(db)) {
      const session = yield* attempt(async () => chatSession(db, stream.chat))
      produce.know(stream.chat, session)
      const cursor = storedCursor(stream.cursorJson)
      if (cursor?.run !== undefined || cursor?.message !== undefined)
        yield* Queue.offer(queue, { kind: 'commit', session })
    }
  })
