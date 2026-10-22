import type { AgentEvent, AgentEventStream, CommitPublication, SnapshotEvent } from '@earendil-works/pi-durable'
import type { AguiEvent, StreamTier } from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import { chatSession } from '../chats/directory.ts'
import { type AppError, attempt, toAppError } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import type { PiSessions } from '../pi/sessions.ts'
import {
  type ChildSent,
  type Hints,
  type StreamCursor,
  type Translation,
  reconcile,
  startCursor,
  translate,
} from './agui.ts'
import { bodiesOf, bytesOf, cursorJson, isBoundary, isRunEnd, movedBody, opening, storedCursor } from './bodies.ts'
import { ChildFollow, type ChildMessage, type ChildPorts } from './child-follow.ts'
import { type StoredStream, appendWrites, beginEpoch, streamKey, streamsOf } from './store.ts'
import type { QueuedParts } from './state.ts'
import { coalesce, forTier } from './tiers.ts'

// The producer of a workspace's chat streams (docs/architecture/streams.md). One fiber takes every message in turn, so
// a chat's cursors, pending events and watch change in one place: Pi's commits say which chats have activity, a watch
// (`watchEvents`) follows each such chat's events, each batch is translated once per tier and appended at most every
// 250 ms or at once at a boundary, and an epoch begins with a snapshot when a stream is joined, moves on at a run's end
// past its size or age, or loses its stream. Its writes go out through the outbox (`outbox.ts`).

/** How long a batch's events wait for more before they are appended; a boundary sends them at once. */
const FLUSH_MS = 250
/** How long a watch outlives its chat's last batch once nothing runs there; a commit starts it again. */
const IDLE_MS = 30_000
/** An epoch past this many bytes, or this old, moves on at its next run's end. */
const ROTATE_BYTES = 4 * 1024 * 1024
const ROTATE_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Why a stream begins a new epoch: it has none yet (`new`), it outgrew its limits (`limit`), its row could not be read
 * (`unproven`), or its stream is gone or out of step (`lost`). Only a `lost` stream gets no `goblin.stream.moved`.
 */
type Begin = 'new' | 'limit' | 'unproven' | 'lost'

/** A chat's stream in one tier as the producer follows it: its row, the newest cursor and what is not appended yet. */
type Row = {
  readonly chat: string
  readonly tier: StreamTier
  epoch: number
  nextSeq: number
  bytes: number
  startedAt: number
  cursor: StreamCursor
  pending: AguiEvent[]
  /** A flush is armed. */
  armed: boolean
  begin?: Begin | undefined
}

/** A chat whose streams the producer follows: its Pi session, its streams, and its watch with its generation. */
type ChatState = {
  readonly chat: string
  readonly session: string
  readonly rows: Map<StreamTier, Row>
  /** Bumped by every new watch: a batch of an older one is stale. */
  gen: number
  watch?: AgentEventStream | undefined
  lastBatchAt: number
}

/** What the producer's one fiber takes, in order: its chats' and their children's (`child-follow.ts`). */
type Message =
  | ChildMessage
  | { readonly kind: 'commit'; readonly session: string }
  | { readonly kind: 'batch'; readonly chat: string; readonly gen: number; readonly events: readonly AgentEvent[] }
  | { readonly kind: 'flush'; readonly chat: string; readonly tier: StreamTier }
  | { readonly kind: 'idle'; readonly chat: string; readonly gen: number; readonly at: number }
  | { readonly kind: 'closed'; readonly chat: string; readonly gen: number }
  | { readonly kind: 'lost'; readonly chat: string; readonly tier: StreamTier; readonly epoch: number }
  | {
      readonly kind: 'join'
      readonly chat: string
      readonly tier: StreamTier
      readonly done: Deferred.Deferred<number, AppError>
    }

export type ProducerPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly pi: PiSessions['Service']
  readonly scope: Scope.Scope
  readonly queue: Queue.Queue<Message>
  /** Starts a stream's drain (`outbox.ts`). */
  readonly drain: (key: string) => Effect.Effect<void>
  /** Bytes past which an epoch moves on; `ROTATE_BYTES` unless a fixture sets fewer. */
  readonly rotateBytes: number | undefined
  /** What the session's queued inputs say now (`InboxDoc`), by submission id: the `/queue` of its streams. */
  readonly queued: (session: string) => Effect.Effect<ReadonlyMap<number, QueuedParts>>
  /** The Persona invocations and revisions the chats' children are named by. */
  readonly personas: Pick<ChildPorts, 'working' | 'invocation' | 'persona' | 'promptEntry'>
}

export type { Message as ProducerMessage }

/** The row as stored. */
const storedOf = (row: Row): StoredStream => ({
  chat: row.chat,
  tier: row.tier,
  epoch: row.epoch,
  nextSeq: row.nextSeq,
  bytes: row.bytes,
  startedAt: row.startedAt,
  cursorJson: cursorJson(row.cursor),
})

/** A stored row as the producer follows it; one it cannot read begins a new epoch. */
const rowOf = (stored: StoredStream): Row => {
  const cursor = storedCursor(stored.cursorJson)
  return {
    chat: stored.chat,
    tier: stored.tier,
    epoch: stored.epoch,
    nextSeq: stored.nextSeq,
    bytes: stored.bytes,
    startedAt: stored.startedAt,
    cursor: cursor ?? startCursor(stored.chat),
    pending: [],
    armed: false,
    begin: cursor === undefined ? 'unproven' : undefined,
  }
}

/** A batch that changed the queue to hold something. */
const queues = (event: AgentEvent): boolean => event.type === 'inbox_update' && event.items.length > 0

/** Whether anything runs in the chat as its streams saw last. */
const busy = (state: ChatState): boolean =>
  [...state.rows.values()].some(({ cursor }) => cursor.run !== undefined || cursor.message !== undefined)

/** The chats Pi's commit touched, by Pi session. */
export const touchedSessions = (publication: CommitPublication): Set<string> => {
  const sessions = new Set<string>()
  for (const change of publication.changes) {
    if (change.type === 'entry' || change.type === 'submission') sessions.add(String(change.value.conversationId))
    else if (change.type === 'document' && change.conversationId !== undefined)
      sessions.add(String(change.conversationId))
  }
  return sessions
}

/** A row for a tier that has no stream yet: its first epoch begins with the next watch. */
const newRow = (chat: string, tier: StreamTier): Row => ({
  chat,
  tier,
  epoch: 0,
  nextSeq: 0,
  bytes: 0,
  startedAt: 0,
  cursor: startCursor(chat),
  pending: [],
  armed: false,
  begin: 'new',
})

/** The size of `bodies` as the stream counts it. */
const sizeOf = (bodies: readonly string[]): number => bodies.reduce((sum, body) => sum + bytesOf(body), 0)

/**
 * A new epoch's writes for `row`, which takes it from `snapshot` at `now`: its opening events (the first body creates
 * the stream, any other is appended), and unless its stream was lost the old epoch's `goblin.stream.moved` and close.
 */
function nextEpoch(row: Row, snapshot: SnapshotEvent, now: number, hints: Hints) {
  const reason = row.begin ?? 'new'
  const epoch = row.epoch + 1
  const opened = opening(row.chat, snapshot, row.tier, hints)
  const bodies = bodiesOf(opened.events)
  const closing =
    row.epoch === 0 || reason === 'lost'
      ? undefined
      : {
          epoch: row.epoch,
          writes: [
            { seq: row.nextSeq, body: movedBody(epoch) },
            { seq: row.nextSeq + 1, body: '' },
          ],
        }
  Object.assign(row, {
    epoch,
    nextSeq: bodies.length - 1,
    bytes: sizeOf(bodies),
    startedAt: now,
    cursor: opened.cursor,
    pending: [],
    begin: undefined,
  })
  return { writes: bodies.map((body, index) => ({ seq: index - 1, body })), closing }
}

/**
 * The producer: its chats, and what its fiber does with each message. Every method runs in the fiber's turn, so the
 * state it keeps needs no lock.
 */
export class Producer {
  readonly #ports: ProducerPorts
  readonly #chats = new Map<string, ChatState>()
  /** Every Pi session of a chat with streams, and the ones a watch follows now. */
  readonly #sessions = new Map<string, string>()
  readonly #watching = new Set<string>()
  /** The chats whose work the chats' streams carry: Personas' forks and subagents. */
  readonly #children: ChildFollow
  constructor(ports: ProducerPorts) {
    this.#ports = ports
    const { db, pi, scope, queue, personas } = ports
    const offer = (message: ChildMessage) => void Queue.offerUnsafe(queue, message)
    this.#children = new ChildFollow(
      { db, pi, scope, offer, ...personas },
      {
        streamed: (chat) => this.#stateOf(chat) !== undefined,
        carried: (chat) => this.#carried(chat),
        step: (chat, step) => this.#step(chat, step),
      },
    )
  }

  /** The fiber's work: every message in turn; one that fails is reported and the next one taken. */
  get run(): Effect.Effect<never> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.#ports.queue), (message) =>
        Effect.suspend(() => this.#handle(message)).pipe(reportAndRecover('streams.produce', undefined)),
      ),
    )
  }

  /** Pi's commit, inside it: the sessions with streams, or children's, and no watch are noted, nothing more. */
  noticed(publication: CommitPublication): void {
    for (const session of touchedSessions(publication))
      if ((this.#sessions.has(session) && !this.#watching.has(session)) || this.#children.idle(session))
        Queue.offerUnsafe(this.#ports.queue, { kind: 'commit', session })
  }

  /** The chat's streams are known, so its commits start a watch. */
  know(chat: string, session: string): void {
    this.#sessions.set(session, chat)
  }

  #later(ms: number, message: Message): Effect.Effect<void> {
    return Effect.asVoid(
      Effect.forkIn(Effect.andThen(Effect.sleep(ms), Queue.offer(this.#ports.queue, message)), this.#ports.scope),
    )
  }

  /** The chat's state, from its rows the first time; none for a chat without streams. */
  #stateOf(chat: string): ChatState | undefined {
    const known = this.#chats.get(chat)
    if (known !== undefined) return known
    const stored = streamsOf(this.#ports.db, chat)
    if (stored.length === 0) return undefined
    const session = chatSession(this.#ports.db, chat)
    const state: ChatState = { chat, session, rows: new Map(), gen: 0, lastBatchAt: 0 }
    for (const each of stored) state.rows.set(each.tier, rowOf(each))
    this.#chats.set(chat, state)
    this.#sessions.set(session, chat)
    return state
  }

  /** Appends the row's pending events to its current epoch. */
  #flush(row: Row): Effect.Effect<void> {
    if (row.pending.length === 0) return Effect.void
    const bodies = bodiesOf(coalesce(row.pending))
    const writes = bodies.map((body, index) => ({ seq: row.nextSeq + index, body }))
    row.pending = []
    row.nextSeq += bodies.length
    row.bytes += sizeOf(bodies)
    appendWrites(this.#ports.db, storedOf(row), writes)
    return this.#ports.drain(streamKey(row.chat, row.tier))
  }

  /** A new epoch from `snapshot`; what the old one still had is appended to it first, unless its stream was lost. */
  #begin(row: Row, snapshot: SnapshotEvent, now: number, hints: Hints): Effect.Effect<void> {
    const flushed = row.begin === 'lost' ? Effect.void : this.#flush(row)
    return Effect.andThen(
      flushed,
      Effect.suspend(() => {
        const { writes, closing } = nextEpoch(row, snapshot, now, hints)
        beginEpoch(this.#ports.db, storedOf(row), writes, closing)
        return this.#ports.drain(streamKey(row.chat, row.tier))
      }),
    )
  }

  /** The children the chat's streams carry now, each as the first stream that carries it has it. */
  #carried(chat: string): ReadonlyMap<string, ChildSent> {
    const carried = new Map<string, ChildSent>()
    for (const row of this.#chats.get(chat)?.rows.values() ?? [])
      for (const [child, sent] of Object.entries(row.cursor.children ?? {}))
        if (!carried.has(child)) carried.set(child, sent)
    return carried
  }

  /**
   * `step` over the cursor of each of the chat's streams (one waiting for a new epoch takes the step there): what it
   * answers pending in the row's tier, appended at once at a boundary or armed for `FLUSH_MS`.
   */
  #step(chat: string, step: (cursor: StreamCursor) => Translation): Effect.Effect<void> {
    const rows = [...(this.#chats.get(chat)?.rows.values() ?? [])].filter(({ begin }) => begin === undefined)
    return Effect.forEach(
      rows,
      (row) => {
        const stepped = step(row.cursor)
        row.cursor = stepped.cursor
        return this.#pend(row, forTier(stepped.events, row.tier))
      },
      { discard: true },
    )
  }

  /** `events` pending in the row: appended at once when one is a boundary, else with the next flush. */
  #pend(row: Row, events: readonly AguiEvent[]): Effect.Effect<void> {
    if (events.length === 0) return Effect.void
    row.pending.push(...events)
    if (events.some(isBoundary)) return this.#flush(row)
    const arm = row.armed ? Effect.void : this.#later(FLUSH_MS, { kind: 'flush', chat: row.chat, tier: row.tier })
    row.armed = true
    return arm
  }

  /** Catches the row up from `snapshot`: what happened since its cursor, appended at once. */
  #catchUp(row: Row, snapshot: SnapshotEvent, hints: Hints): Effect.Effect<void> {
    const caught = reconcile(row.cursor, snapshot, hints)
    row.cursor = caught.cursor
    row.pending.push(...forTier(caught.events, row.tier))
    return this.#flush(row)
  }

  /** No batch since `state.lastBatchAt` and nothing running: the watch stops after `IDLE_MS`. */
  #armIdle(state: ChatState): Effect.Effect<void> {
    if (busy(state)) return Effect.void
    return this.#later(IDLE_MS, { kind: 'idle', chat: state.chat, gen: state.gen, at: state.lastBatchAt })
  }

  /** Stops the chat's watch, if it has one; a batch it still delivers is stale. */
  #unwatch(state: ChatState): Effect.Effect<void> {
    state.gen += 1
    const old = state.watch
    state.watch = undefined
    this.#watching.delete(state.session)
    if (old === undefined) return Effect.void
    return attempt(() => old.stop()).pipe(Effect.asVoid, reportAndRecover('streams.unwatch', undefined))
  }

  /** Follows `stream` as the chat's watch: its batches and its end come in through the queue with its generation. */
  #follow(state: ChatState, stream: AgentEventStream): void {
    const { queue } = this.#ports
    const { chat, gen } = state
    state.watch = stream
    this.#watching.add(state.session)
    stream.start(async (events) => {
      Queue.offerUnsafe(queue, { kind: 'batch', chat, gen, events })
      await Promise.resolve()
    })
    // A watch Pi ends (the session closed or failed) is noted, so the chat's next commit starts another.
    const ended = () => void Queue.offerUnsafe(queue, { kind: 'closed', chat, gen })
    stream.closed.then(ended, ended)
  }

  /**
   * A new watch of the chat: its snapshot begins each stream that needs a new epoch and catches up every other, and it
   * is followed from there.
   */
  #attach(state: ChatState): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.#unwatch(state)
      const stream = yield* this.#ports.pi
        .events(state.session)
        .pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
      const now = yield* Clock.currentTimeMillis
      const hints = yield* this.#hints(state, stream.snapshot.inbox.length > 0)
      for (const row of state.rows.values())
        yield* row.begin === undefined
          ? this.#catchUp(row, stream.snapshot, hints)
          : this.#begin(row, stream.snapshot, now, hints)
      state.lastBatchAt = now
      this.#follow(state, stream)
      yield* this.#armIdle(state)
      yield* this.#children.attached(state.chat)
    })
  }

  /**
   * One batch for one row: its events in the row's tier pending, appended at once at a boundary or armed for
   * `FLUSH_MS`. True when the batch ended a run with the epoch past its limits, so it moves on.
   */
  #take(row: Row, events: readonly AgentEvent[], now: number, hints: Hints): Effect.Effect<boolean> {
    const translated = translate(row.cursor, events, hints)
    row.cursor = translated.cursor
    const mine = forTier(translated.events, row.tier)
    const past = row.bytes >= (this.#ports.rotateBytes ?? ROTATE_BYTES) || now - row.startedAt >= ROTATE_AGE_MS
    return Effect.as(this.#pend(row, mine), past && mine.some(isRunEnd) && row.cursor.run === undefined)
  }

  /** One batch of the chat's watch, translated once per tier; a run's end past an epoch's limits moves it on. */
  #onBatch(state: ChatState, events: readonly AgentEvent[]): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      state.lastBatchAt = now
      let moves = false
      const hints = yield* this.#hints(state, events.some(queues))
      for (const row of state.rows.values())
        if (yield* this.#take(row, events, now, hints)) {
          row.begin = 'limit'
          moves = true
        }
      yield* moves ? this.#attach(state) : this.#armIdle(state)
    })
  }

  /** What the chat's queued inputs say, read only when something waits in its queue. */
  #hints(state: ChatState, waiting: boolean): Effect.Effect<Hints> {
    return waiting ? Effect.map(this.#ports.queued(state.session), (queued) => ({ queued })) : Effect.succeed({})
  }

  /** A join: the row for its tier, begun with a new watch when it is new, and the epoch a reader reads. */
  #onJoin(chat: string, tier: StreamTier): Effect.Effect<number, AppError> {
    return Effect.gen({ self: this }, function* () {
      const session = yield* attempt(async () => chatSession(this.#ports.db, chat))
      const state: ChatState = this.#stateOf(chat) ?? { chat, session, rows: new Map(), gen: 0, lastBatchAt: 0 }
      this.#chats.set(chat, state)
      this.#sessions.set(session, chat)
      const row = state.rows.get(tier) ?? newRow(chat, tier)
      state.rows.set(tier, row)
      if (state.watch === undefined || row.begin !== undefined) yield* this.#attach(state)
      return row.epoch
    })
  }

  /** The chat whose streams `message` is about, when it has a watch of `message.gen`. */
  #current(message: { readonly chat: string; readonly gen: number }): ChatState | undefined {
    const state = this.#chats.get(message.chat)
    return state?.gen === message.gen ? state : undefined
  }

  /** The watch went quiet: what is pending goes out and the watch stops, unless a batch came or a run goes on. */
  #onIdle(message: Extract<Message, { kind: 'idle' }>): Effect.Effect<void> {
    const state = this.#current(message)
    if (state === undefined || state.lastBatchAt !== message.at || busy(state)) return Effect.void
    return Effect.andThen(
      Effect.forEach(state.rows.values(), (row) => this.#flush(row)),
      Effect.suspend(() => this.#unwatch(state)),
    )
  }

  /** The epoch's stream is gone or out of step: the chat's stream in that tier begins a new epoch. */
  #onLost(message: Extract<Message, { kind: 'lost' }>): Effect.Effect<void, AppError> {
    const state = this.#stateOf(message.chat)
    const row = state?.rows.get(message.tier)
    if (state === undefined || row?.epoch !== message.epoch) return Effect.void
    row.begin = 'lost'
    return this.#attach(state)
  }

  /** A commit of a session without a watch: a chat with streams is attached again, a child is followed again. */
  #onCommit(session: string): Effect.Effect<void, AppError> {
    const chat = this.#sessions.get(session)
    if (chat === undefined) return this.#children.committed(session)
    const state = this.#stateOf(chat)
    return state === undefined || state.watch !== undefined ? Effect.void : this.#attach(state)
  }

  /** One message, in the fiber's turn. */
  #handle(message: Message): Effect.Effect<void, AppError> {
    switch (message.kind) {
      case 'commit':
        return this.#onCommit(message.session)
      case 'batch': {
        const state = this.#current(message)
        return state === undefined ? Effect.void : this.#onBatch(state, message.events)
      }
      case 'flush': {
        const row = this.#chats.get(message.chat)?.rows.get(message.tier)
        if (row !== undefined) row.armed = false
        return row === undefined ? Effect.void : this.#flush(row)
      }
      case 'idle':
        return this.#onIdle(message)
      case 'closed': {
        const state = this.#current(message)
        if (state !== undefined) this.#watching.delete(state.session)
        if (state !== undefined) state.watch = undefined
        return Effect.void
      }
      case 'lost':
        return this.#onLost(message)
      case 'join':
        return Effect.matchEffect(this.#onJoin(message.chat, message.tier), {
          onFailure: (error) => Deferred.fail(message.done, error),
          onSuccess: (epoch) => Deferred.succeed(message.done, epoch),
        })
      case 'child-batch':
      case 'child-closed':
      case 'child-idle':
      case 'invocations':
      case 'conversations':
        return this.#children.handle(message)
    }
  }
}
