import type { StreamTier } from '@goblin/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import { chatSession } from '../chats/directory.ts'
import { type AppError, Conflict, Internal, attempt, toAppError } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { personaPromptId } from '../pi/persona-turn.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { queuedInputs } from '../conversation-queue.ts'
import { storedCursor } from '../streams/bodies.ts'
import type { ChildPorts } from '../streams/child-follow.ts'
import type { QueuedParts } from '../streams/state.ts'
import { queuedParts } from '../streams/user.ts'
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
    const queued = (session: string) =>
      Effect.gen(function* () {
        const harness = yield* pi.pi.pipe(
          Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
        )
        const { inputs } = yield* attempt(() => queuedInputs(harness, session))
        return new Map(inputs.map(({ id, content }) => [id, queuedParts(content)]))
      }).pipe(reportAndRecover('streams.queue', new Map<number, QueuedParts>()))
    const produce = new Producer({
      db,
      pi,
      scope,
      queue,
      drain: out.request,
      rotateBytes: rotateBytesOf(env.STREAM_ROTATE_BYTES),
      queued,
      personas: yield* personaPorts,
    })
    yield* Effect.forkScoped(produce.run)
    yield* childChanges(queue)
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

/** Invocations that start or settle, and subagents that open or close, move the children the streams carry. */
const childChanges = (queue: Queue.Queue<ProducerMessage>) =>
  Effect.gen(function* () {
    const changes = yield* Changes
    const invocations = yield* Invocations
    // Each invocation as the change left it, read in the writer's step: by the producer's turn it may have moved on.
    yield* changes.on('invocations.changed', ({ ids }) =>
      Effect.forEach(ids, ({ operationId, persona }) => invocations.get(operationId, persona)).pipe(
        Effect.flatMap((found) => Queue.offer(queue, { kind: 'invocations', views: found.flatMap(Option.toArray) })),
      ),
    )
    yield* changes.on('conversations.changed', ({ ids }) => Queue.offer(queue, { kind: 'conversations', ids }))
  })

/** The prompt an invocation asked its fork with, as Pi placed it: its entry, once it has one. */
const promptEntry = (pi: PiSessions['Service'], fork: string, operationId: string, persona: number) =>
  Effect.gen(function* () {
    const harness = yield* fromPi(pi.pi)
    for (const resumed of [false, true]) {
      const requestId = personaPromptId(operationId, persona, resumed)
      const record = yield* attempt(() =>
        harness.commit((tx) => tx.submissionByRequest(conversationId(fork), requestId), BACKGROUND),
      )
      if (record?.entry !== undefined) return Number(record.entry)
    }
    return undefined
  }).pipe(reportAndRecover('streams.prompt', undefined))

/** The Persona invocations and revisions a chat's children are named by: what the producer reads of them. */
const personaPorts = Effect.gen(function* () {
  const invocations = yield* Invocations
  const personas = yield* Personas
  const pi = yield* PiSessions
  return {
    promptEntry: (fork: string, operationId: string, persona: number) => promptEntry(pi, fork, operationId, persona),
    working: invocations.working,
    invocation: (operationId, persona) => Effect.map(invocations.get(operationId, persona), Option.getOrUndefined),
    persona: (id, revision) =>
      personas.revision(id, revision).pipe(
        Effect.map(({ name, avatar }) => ({ name, avatar })),
        // expected: a revision that cannot be read names no child; its work is not carried
        Effect.orElseSucceed(() => undefined),
      ),
  } satisfies Pick<ChildPorts, 'working' | 'invocation' | 'persona' | 'promptEntry'>
})

/**
 * Pi's commits from now on, and the chats with streams: each is known by its session, and one whose streams saw a run
 * in flight, or carried a child's work, is caught up at once (it went on, or ended, while the agent was away).
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
      if (cursor?.run !== undefined || cursor?.message !== undefined || cursor?.children !== undefined)
        yield* Queue.offer(queue, { kind: 'commit', session })
    }
  })
