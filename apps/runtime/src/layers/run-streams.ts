import type { AgentEvent, AgentEventStream, SnapshotEvent } from '@earendil-works/pi-durable'
import type { AguiEvent } from '@goblin/contracts'
import type * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { chatSession } from '../chats/directory.ts'
import { Conflict, attempt } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Invocations } from '../personas/service.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import type { Hints } from '../streams/agui.ts'
import { bounded, opening } from '../streams/bodies.ts'
import { RunFollow, type RunTarget } from '../streams/run.ts'
import { RunStreams } from '../streams/service.ts'
import { operations, queued } from './streams.ts'

// Each send's run as AG-UI events (ADR 0111, docs/architecture/streams.md "Driving a chat"): a watch of the chat of its
// own, opened before the send is admitted so nothing of its run is missed, its batches translated over its own cursor
// by `RunFollow` in a fiber of the runtime's scope, and handed to the request's body until the run's end.

/** The run streams the agent takes at once; one more is `Conflict` `stream_busy`. */
const RUN_STREAMS = 32
/** A run stream's longest life: then it ends in error, and the run goes on in the chat. */
const LIFETIME_MS = 15 * 60 * 1000
/** How many batches a request's body holds before its run stream is let go. */
const SINK_BATCHES = 512

/** What a run stream's fiber takes in turn: its watch's batches, its end, and a change of the ask's invocations. */
type Message =
  | { readonly kind: 'batch'; readonly events: readonly AgentEvent[] }
  | { readonly kind: 'closed' }
  | { readonly kind: 'invocations' }

type Inbox = Queue.Queue<Message>
type Sink = Queue.Queue<readonly AguiEvent[], Cause.Done>

/** What the run streams share: the agent's services they read, their fibers' scope, and the streams open now. */
type Ports = {
  readonly db: Db['Service']
  readonly pi: PiSessions['Service']
  readonly invocations: Invocations['Service']
  readonly scope: Scope.Scope
  /** The ask streams by operation, told when its invocations change. */
  readonly asks: Map<string, Set<Inbox>>
  open: number
}

/** One run stream's watch of its chat, its inbox, and how it lets go of both. */
type Watched = {
  readonly session: string
  readonly watch: AgentEventStream
  readonly inbox: Inbox
  readonly close: Effect.Effect<void>
}

/** A batch that changed the queue to hold something. */
const queues = (events: readonly AgentEvent[]): boolean =>
  events.some((event) => event.type === 'inbox_update' && event.items.length > 0)

/** The inputs a snapshot names: its run's and the queue's, by submission id. */
const namedInputs = (snapshot: SnapshotEvent): number[] =>
  [...(snapshot.run?.inputs ?? []), ...snapshot.inbox.map(({ id }) => id)].map(Number)

/** `events` into the request's body, each small enough to send; false when the body holds too much unread. */
const sent = (sink: Sink, events: readonly AguiEvent[]): boolean => {
  const kept = events.flatMap((event) => bounded(event) ?? [])
  return kept.length === 0 || Queue.offerUnsafe(sink, kept)
}

/** The record Pi keeps of the operation in the chat's conversation, if any. */
const lookup = (ports: Ports, session: string, operationId: string) =>
  Effect.gen(function* () {
    const harness = yield* fromPi(ports.pi.pi)
    return yield* attempt(() =>
      harness.commit((tx) => tx.submissionByRequest(conversationId(session), operationId), BACKGROUND),
    )
  })

/** What the watch's snapshot needs that it does not say: what its queued inputs say, and its inputs' operations. */
const hintsOf = (ports: Ports, session: string, snapshot: SnapshotEvent) =>
  Effect.gen(function* () {
    const inputs = namedInputs(snapshot)
    const said = snapshot.inbox.length > 0 ? yield* queued(ports.pi, session) : undefined
    const named = inputs.length > 0 ? yield* operations(ports.pi, inputs) : undefined
    return { ...(said === undefined ? {} : { queued: said }), ...(named === undefined ? {} : { operations: named }) }
  })

/**
 * A watch of the target's chat of its own, its batches and end into its inbox, and an ask's changes too. Counted
 * before anything waits, so streams asked for together never pass the bound.
 */
const watchFor = (ports: Ports, target: RunTarget) =>
  Effect.gen(function* () {
    if (ports.open >= RUN_STREAMS) return yield* new Conflict({ reason: 'stream_busy' })
    ports.open += 1
    const opened = Effect.gen(function* () {
      const session = yield* attempt(async () => chatSession(ports.db, target.chat))
      return { session, watch: yield* fromPi(ports.pi.events(session)) }
    })
    const { session, watch } = yield* opened.pipe(Effect.onError(() => Effect.sync(() => void (ports.open -= 1))))
    const inbox = yield* Queue.unbounded<Message>()
    watch.start(async (events) => {
      Queue.offerUnsafe(inbox, { kind: 'batch', events })
      await Promise.resolve()
    })
    const ended = () => void Queue.offerUnsafe(inbox, { kind: 'closed' })
    watch.closed.then(ended, ended)
    const listening = ports.asks.get(target.runId) ?? new Set<Inbox>()
    if (target.ask) ports.asks.set(target.runId, listening.add(inbox))
    let closed = false
    const close = Effect.suspend(() => {
      if (closed) return Effect.void
      closed = true
      ports.open -= 1
      listening.delete(inbox)
      if (listening.size === 0) ports.asks.delete(target.runId)
      return attempt(() => watch.stop()).pipe(Effect.asVoid, reportAndRecover('streams.run.unwatch', undefined))
    })
    return { session, watch, inbox, close } satisfies Watched
  })

/** The ask's invocations now, as the follower takes them. */
const settled = (ports: Ports, target: RunTarget, follow: RunFollow) =>
  target.ask ? Effect.map(ports.invocations.of(target.runId), (views) => follow.invocations(views)) : Effect.succeed([])

/** What one message gives the follower to send. */
const step = (ports: Ports, target: RunTarget, watched: Watched, follow: RunFollow, message: Message) =>
  Effect.gen(function* () {
    if (message.kind === 'closed') return follow.ended('stream_ended')
    if (message.kind === 'invocations') return yield* settled(ports, target, follow)
    const hints: Hints = queues(message.events) ? { queued: yield* queued(ports.pi, watched.session) } : {}
    return [...follow.batch(message.events, hints), ...(yield* settled(ports, target, follow))]
  })

/** One run stream's follower and the events it sends first. */
type Begun = { readonly follow: RunFollow; readonly first: readonly AguiEvent[] }

/**
 * The follower's work until the run's end: each message in turn, its events into the request's body. A body that
 * holds too many batches unread is let go; past its life the stream ends in error. The watch is let go either way.
 */
const drive = (ports: Ports, target: RunTarget, watched: Watched, begun: Begun, sink: Sink) =>
  Effect.gen(function* () {
    const { follow, first } = begun
    const deadline = (yield* Clock.currentTimeMillis) + LIFETIME_MS
    if (!sent(sink, first) || !sent(sink, yield* settled(ports, target, follow))) return
    while (!follow.done) {
      const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
      const message = yield* Queue.take(watched.inbox).pipe(Effect.timeoutOption(left))
      const events = Option.isNone(message)
        ? follow.ended('stream_lifetime')
        : yield* step(ports, target, watched, follow, message.value)
      if (!sent(sink, events)) return
    }
  }).pipe(
    reportAndRecover('streams.run', undefined),
    Effect.ensuring(
      Effect.andThen(
        watched.close,
        Effect.sync(() => Queue.endUnsafe(sink)),
      ),
    ),
  )

/**
 * The send's run: its watch opened, then the send admitted (`admit`), its record read before and after, and its
 * follower started from the watch's snapshot; then a fiber follows it into the body the stream reads. A failed
 * admission lets the watch go and is the request's failure.
 */
const follow =
  (ports: Ports) =>
  <E, R>(target: RunTarget, admit: Effect.Effect<unknown, E, R>) =>
    Effect.gen(function* () {
      const watched = yield* watchFor(ports, target)
      const begun = yield* Effect.gen(function* () {
        const prior = yield* lookup(ports, watched.session, target.runId)
        yield* admit
        const record = yield* lookup(ports, watched.session, target.runId)
        const hints = yield* hintsOf(ports, watched.session, watched.watch.snapshot)
        const follower = new RunFollow(target, opening(target.chat, watched.watch.snapshot, hints))
        return { follow: follower, first: follower.admitted(prior, record) }
      }).pipe(Effect.onError(() => watched.close))
      const sink = yield* Queue.bounded<readonly AguiEvent[], Cause.Done>(SINK_BATCHES)
      const fiber = yield* Effect.forkIn(drive(ports, target, watched, begun, sink), ports.scope)
      return Stream.fromQueue(sink).pipe(Stream.ensuring(Fiber.interrupt(fiber)))
    }).pipe(Effect.withSpan('RunStreams.follow'))

/** The sends' run streams (ADR 0111), their fibers in the runtime's scope; an ask hears of its invocations' changes. */
export const RunStreamsLive = Layer.effect(
  RunStreams,
  Effect.gen(function* () {
    const ports: Ports = {
      db: yield* Db,
      pi: yield* PiSessions,
      invocations: yield* Invocations,
      scope: yield* Effect.scope,
      asks: new Map(),
      open: 0,
    }
    yield* (yield* Changes).on('invocations.changed', ({ ids }) =>
      Effect.sync(() => {
        for (const { operationId } of ids)
          for (const inbox of ports.asks.get(operationId) ?? []) Queue.offerUnsafe(inbox, { kind: 'invocations' })
      }),
    )
    return RunStreams.of({ follow: follow(ports) })
  }),
)
