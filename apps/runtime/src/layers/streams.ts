import type { AguiEvent } from '@goblin/contracts'
import type * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import { type AppError, attempt } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { BACKGROUND, conversationId, submissionId } from '../pi/context.ts'
import { personaPromptId } from '../pi/persona-turn.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { queuedInputs } from '../conversation-queue.ts'
import type { ChildPorts } from '../streams/child-follow.ts'
import type { QueuedParts } from '../streams/state.ts'
import { queuedParts } from '../streams/user.ts'
import { Producer, type ProducerMessage } from '../streams/producer.ts'
import { Streams } from '../streams/service.ts'

/** How many batches a reader's sink holds before the producer lets the reader go. */
const SINK_BATCHES = 512

/**
 * The chat streams (docs/architecture/streams.md): the producer's fiber in the runtime's scope, Pi's commits noticed
 * from the start, and each reader's join of a chat answered with its own stream of the chat's events, which leaves
 * the chat when it ends, and the signal that ends its connection when the producer lets it go.
 */
export const StreamsLive = Layer.effect(
  Streams,
  Effect.gen(function* () {
    const db = yield* Db
    const pi = yield* PiSessions
    const scope = yield* Effect.scope
    const queue = yield* Queue.unbounded<ProducerMessage>()
    const produce = new Producer({
      db,
      pi,
      scope,
      queue,
      queued: (session) => queued(pi, session),
      operations: (inputs) => operations(pi, inputs),
      personas: yield* personaPorts,
    })
    yield* Effect.forkScoped(produce.run)
    yield* childChanges(queue)
    yield* start(produce, pi).pipe(reportAndRecover('streams.start', undefined))
    let readers = 0
    const watch = Effect.fn('Streams.watch')(function* (chat: string) {
      readers += 1
      const row = readers
      const sink = yield* Queue.bounded<readonly AguiEvent[], Cause.Done>(SINK_BATCHES)
      const done = yield* Deferred.make<void, AppError>()
      const ended = new AbortController()
      const leave = Queue.offer(queue, { kind: 'leave', chat, row })
      yield* Queue.offer(queue, { kind: 'join', chat, row, sink, done, release: () => ended.abort() })
      // A request that goes away before its opening came leaves at once.
      yield* Deferred.await(done).pipe(Effect.onInterrupt(() => leave))
      return { batches: Stream.fromQueue(sink).pipe(Stream.ensuring(leave)), released: ended.signal }
    })
    return Streams.of({ watch })
  }),
)

/** What the session's queued inputs say now, by submission id; nothing when the inbox cannot be read. */
export const queued = (pi: PiSessions['Service'], session: string) =>
  Effect.gen(function* () {
    const harness = yield* fromPi(pi.pi)
    const { inputs } = yield* attempt(() => queuedInputs(harness, session))
    return new Map(inputs.map(({ id, content }) => [id, queuedParts(content)]))
  }).pipe(reportAndRecover('streams.queue', new Map<number, QueuedParts>()))

/**
 * The operation ids of `inputs` (a snapshot's run's and queue's), by submission id: Pi's snapshot names its inputs
 * without them, so a reader that opens mid-run still learns which operations its run answers.
 */
export const operations = (pi: PiSessions['Service'], inputs: readonly number[]) =>
  Effect.gen(function* () {
    const harness = yield* fromPi(pi.pi)
    const found = new Map<number, string>()
    for (const input of inputs) {
      const record = yield* attempt(async () =>
        (await harness.submission(submissionId(input), BACKGROUND))?.status(BACKGROUND),
      )
      if (record?.type === 'input' && record.requestId !== undefined) found.set(input, record.requestId)
    }
    return found
  }).pipe(reportAndRecover('streams.operations', new Map<number, string>()))

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

/** Pi's commits from now on: a chat with readers whose watch stopped is watched again at its next commit. */
const start = (produce: Producer, pi: PiSessions['Service']) =>
  Effect.gen(function* () {
    const harness = yield* fromPi(pi.pi)
    const unsubscribe = harness.subscribeCommits((publication) => produce.noticed(publication))
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
  })
