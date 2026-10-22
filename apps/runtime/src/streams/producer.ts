import type { AgentEvent, AgentEventStream, CommitPublication, SnapshotEvent } from '@earendil-works/pi-durable'
import type { AguiEvent } from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import { chatSession } from '../chats/directory.ts'
import { type AppError, Conflict, attempt, failureOf, toAppError } from '../http/errors.ts'
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
import { bounded, opening } from './bodies.ts'
import { ChildFollow, type ChildMessage, type ChildPorts } from './child-follow.ts'
import type { QueuedParts } from './state.ts'

// The producer of a workspace's chat streams (docs/architecture/streams.md). One fiber takes every message in turn, so
// each chat's readers, their cursors and the chat's watch change in one place. A reader joins a chat with a sink of its
// own; a burst of joins opens one new watch (`watchEvents`) of the chat, whose snapshot opens each new reader and
// catches every other up. Then each batch is translated over each reader's cursor and handed to its sink at once. The
// fiber never waits on a reader: one whose sink is full is let go, as is one connected for fifteen minutes, and either
// reconnects for a fresh opening. The last reader to leave stops the chat's watch and its children's.

/** How long a watch outlives its chat's last batch once nothing runs there; a commit starts it again. */
const IDLE_MS = 30_000
/**
 * A reader's longest connection: then it is let go. It is the bound on a reader that went away unseen: a connection
 * whose client is gone holds its place until it is let go, since the platform may never tell the agent.
 */
const LIFETIME_MS = 15 * 60 * 1000
/** The readers one chat takes at once, and the agent; one more is `Conflict` `stream_busy`. */
const CHAT_READERS = 32
const AGENT_READERS = 256

/** Where a reader's events go: its connection's batches, ended when the producer lets it go. */
export type Sink = Queue.Queue<readonly AguiEvent[], Cause.Done>

/**
 * One reader of a chat's stream: its connection's sink, its cursor, its join until its opening was sent, and how its
 * connection is ended when the producer lets it go.
 */
type Row = {
  readonly id: number
  readonly sink: Sink
  cursor: StreamCursor
  opened: boolean
  readonly join: Deferred.Deferred<void, AppError>
  readonly release: () => void
}

/** A chat with readers: its Pi session, its readers by id, and its watch with its generation. */
type ChatState = {
  readonly chat: string
  readonly session: string
  readonly rows: Map<number, Row>
  /** Bumped by every new watch: a batch of an older one is stale. */
  gen: number
  watch?: AgentEventStream | undefined
  lastBatchAt: number
  /** A new watch is coming for the readers that joined since the last. */
  attaching: boolean
}

/** What the producer's one fiber takes, in order: its chats' and their children's (`child-follow.ts`). */
type Message =
  | ChildMessage
  | { readonly kind: 'commit'; readonly session: string }
  | { readonly kind: 'batch'; readonly chat: string; readonly gen: number; readonly events: readonly AgentEvent[] }
  | { readonly kind: 'idle'; readonly chat: string; readonly gen: number; readonly at: number }
  | { readonly kind: 'closed'; readonly chat: string; readonly gen: number }
  | {
      readonly kind: 'join'
      readonly chat: string
      readonly row: number
      readonly sink: Sink
      /** Answered once the reader's opening is in its sink, or with why it cannot follow the chat. */
      readonly done: Deferred.Deferred<void, AppError>
      /** Ends the reader's connection, read or not: the producer let it go. */
      readonly release: () => void
    }
  | { readonly kind: 'attach'; readonly chat: string }
  | { readonly kind: 'leave'; readonly chat: string; readonly row: number }

export type ProducerPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly pi: PiSessions['Service']
  readonly scope: Scope.Scope
  readonly queue: Queue.Queue<Message>
  /** What the session's queued inputs say now (`InboxDoc`), by submission id: the `/queue` of its stream. */
  readonly queued: (session: string) => Effect.Effect<ReadonlyMap<number, QueuedParts>>
  /** The operation ids of inputs a snapshot names, by submission id: what its run's RUN_STARTED names. */
  readonly operations: (inputs: readonly number[]) => Effect.Effect<ReadonlyMap<number, string>>
  /** The Persona invocations and revisions the chats' children are named by. */
  readonly personas: Pick<ChildPorts, 'working' | 'invocation' | 'persona' | 'promptEntry'>
}

export type { Message as ProducerMessage }

/** A batch that changed the queue to hold something. */
const queues = (event: AgentEvent): boolean => event.type === 'inbox_update' && event.items.length > 0

/** The chat's readers that have their opening. */
const opened = (state: ChatState): Row[] => [...state.rows.values()].filter((row) => row.opened)

/** Whether anything runs in the chat as its readers saw last. */
const busy = (state: ChatState): boolean =>
  opened(state).some(({ cursor }) => cursor.run !== undefined || cursor.message !== undefined)

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

/** The inputs a snapshot names: its run's and the queue's, by submission id. */
const namedInputs = (snapshot: SnapshotEvent): number[] =>
  [...(snapshot.run?.inputs ?? []), ...snapshot.inbox.map(({ id }) => id)].map(Number)

/**
 * The producer: its chats, and what its fiber does with each message. Every method runs in the fiber's turn, so the
 * state it keeps needs no lock.
 */
export class Producer {
  readonly #ports: ProducerPorts
  readonly #chats = new Map<string, ChatState>()
  /** Every chat with readers, by its Pi session, and the sessions a watch follows now. */
  readonly #sessions = new Map<string, string>()
  readonly #watching = new Set<string>()
  /** The chats whose work the chats' streams carry: Personas' forks and subagents. */
  readonly #children: ChildFollow
  /** Readers of every chat, joined and not yet gone. */
  #readers = 0
  constructor(ports: ProducerPorts) {
    this.#ports = ports
    const { db, pi, scope, queue, personas } = ports
    const offer = (message: ChildMessage) => void Queue.offerUnsafe(queue, message)
    this.#children = new ChildFollow(
      { db, pi, scope, offer, ...personas },
      {
        streamed: (chat) => this.#chats.has(chat),
        carried: (chat) => this.#carried(chat),
        step: (chat, step) => this.#step(chat, step),
      },
    )
  }

  /**
   * The fiber's work: every message in turn, then every chat its readers all left let go; one that fails is reported
   * and the next one taken.
   */
  get run(): Effect.Effect<never> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.#ports.queue), (message) =>
        Effect.suspend(() => this.#handle(message)).pipe(
          Effect.ensuring(Effect.suspend(() => this.#sweep())),
          reportAndRecover('streams.produce', undefined),
        ),
      ),
    )
  }

  /** Pi's commit, inside it: the sessions with readers, or children's, and no watch are noted, nothing more. */
  noticed(publication: CommitPublication): void {
    for (const session of touchedSessions(publication))
      if ((this.#sessions.has(session) && !this.#watching.has(session)) || this.#children.idle(session))
        Queue.offerUnsafe(this.#ports.queue, { kind: 'commit', session })
  }

  #later(ms: number, message: Message): Effect.Effect<void> {
    return Effect.asVoid(
      Effect.forkIn(Effect.andThen(Effect.sleep(ms), Queue.offer(this.#ports.queue, message)), this.#ports.scope),
    )
  }

  /** `events` in the reader's sink at once, each small enough to send; a reader whose sink is full is let go. */
  #send(state: ChatState, row: Row, events: readonly AguiEvent[]): void {
    const kept = events.flatMap((event) => bounded(event) ?? [])
    if (kept.length === 0 || Queue.offerUnsafe(row.sink, kept)) return
    // It fell behind: what its sink holds is still read, then its connection ends and it reconnects for a new opening.
    this.#remove(state, row)
  }

  /** The reader is gone: its sink ends and its connection with it, whether its client still reads or not. */
  #remove(state: ChatState, row: Row): void {
    if (!state.rows.delete(row.id)) return
    this.#readers -= 1
    Queue.endUnsafe(row.sink)
    row.release()
  }

  /** The children the chat's readers carry now, each as the first reader that carries it has it. */
  #carried(chat: string): ReadonlyMap<string, ChildSent> {
    const carried = new Map<string, ChildSent>()
    const state = this.#chats.get(chat)
    for (const row of state === undefined ? [] : opened(state))
      for (const [child, sent] of Object.entries(row.cursor.children ?? {}))
        if (!carried.has(child)) carried.set(child, sent)
    return carried
  }

  /** `step` over the cursor of each of the chat's readers but one waiting for its opening (which starts its children). */
  #step(chat: string, step: (cursor: StreamCursor) => Translation): Effect.Effect<void> {
    return Effect.sync(() => {
      const state = this.#chats.get(chat)
      if (state === undefined) return
      for (const row of opened(state)) {
        const stepped = step(row.cursor)
        row.cursor = stepped.cursor
        this.#send(state, row, stepped.events)
      }
    })
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

  /** What a new watch's snapshot needs that it does not say: what its queued inputs say, and its inputs' operations. */
  #snapshotHints(state: ChatState, snapshot: SnapshotEvent): Effect.Effect<Hints> {
    return Effect.gen({ self: this }, function* () {
      const inputs = namedInputs(snapshot)
      const queued = snapshot.inbox.length > 0 ? yield* this.#ports.queued(state.session) : undefined
      const operations = inputs.length > 0 ? yield* this.#ports.operations(inputs) : undefined
      return { ...(queued === undefined ? {} : { queued }), ...(operations === undefined ? {} : { operations }) }
    })
  }

  /**
   * A new watch of the chat: its snapshot opens each reader that joined since the last (its join is answered then) and
   * catches every other up, and it is followed from there with the chat's children.
   */
  #attach(state: ChatState): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      state.attaching = false
      yield* this.#unwatch(state)
      const stream = yield* this.#ports.pi
        .events(state.session)
        .pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
      const { snapshot } = stream
      const hints = yield* this.#snapshotHints(state, snapshot)
      for (const row of state.rows.values()) {
        const caught = row.opened ? reconcile(row.cursor, snapshot, hints) : opening(state.chat, snapshot, hints)
        row.cursor = caught.cursor
        this.#send(state, row, caught.events)
        if (row.opened) continue
        row.opened = true
        yield* Deferred.succeed(row.join, undefined)
      }
      state.lastBatchAt = yield* Clock.currentTimeMillis
      this.#follow(state, stream)
      yield* this.#armIdle(state)
      yield* this.#children.attached(state.chat)
    }).pipe(Effect.onError((cause) => this.#refuse(state, failureOf(cause))))
  }

  /**
   * The chat could not be watched (Pi failed, or a defect): the readers still waiting for their opening are refused
   * with why, so no join waits forever.
   */
  #refuse(state: ChatState, error: AppError): Effect.Effect<void> {
    const waiting = [...state.rows.values()].filter((row) => !row.opened)
    return Effect.forEach(
      waiting,
      (row) => {
        this.#remove(state, row)
        return Deferred.fail(row.join, error)
      },
      { discard: true },
    )
  }

  /** One batch of the chat's watch, translated over each reader's cursor and sent to it. */
  #onBatch(state: ChatState, events: readonly AgentEvent[]): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      state.lastBatchAt = yield* Clock.currentTimeMillis
      const queued = events.some(queues) ? yield* this.#ports.queued(state.session) : undefined
      const hints: Hints = queued === undefined ? {} : { queued }
      for (const row of opened(state)) {
        const translated = translate(row.cursor, events, hints)
        row.cursor = translated.cursor
        this.#send(state, row, translated.events)
      }
      yield* this.#armIdle(state)
      yield* this.#children.settled(state.chat)
    })
  }

  /**
   * A reader joins: it waits for the chat's next watch, which one message brings for every reader that joins before
   * it. Past the readers a chat or the agent takes, `Conflict` `stream_busy`.
   */
  #onJoin(message: Extract<Message, { kind: 'join' }>): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const { chat, row, sink, done, release } = message
      const known = this.#chats.get(chat)
      const full = this.#readers >= AGENT_READERS || (known?.rows.size ?? 0) >= CHAT_READERS
      if (full) return yield* new Conflict({ reason: 'stream_busy' })
      const state = known ?? (yield* this.#chatState(chat))
      state.rows.set(row, { id: row, sink, cursor: startCursor(chat), opened: false, join: done, release })
      this.#readers += 1
      yield* this.#later(LIFETIME_MS, { kind: 'leave', chat, row })
      if (state.attaching) return
      state.attaching = true
      yield* Queue.offer(this.#ports.queue, { kind: 'attach', chat })
    })
  }

  /** A chat that gets its first reader, known by its session from now on. */
  #chatState(chat: string): Effect.Effect<ChatState, AppError> {
    return Effect.map(
      attempt(async () => chatSession(this.#ports.db, chat)),
      (session) => {
        const state: ChatState = { chat, session, rows: new Map(), gen: 0, lastBatchAt: 0, attaching: false }
        this.#chats.set(chat, state)
        this.#sessions.set(session, chat)
        return state
      },
    )
  }

  /** The reader went away (its connection closed, or it never got its opening), or its connection reached its life. */
  #onLeave(chat: string, id: number): void {
    const state = this.#chats.get(chat)
    const row = state?.rows.get(id)
    if (state !== undefined && row !== undefined) this.#remove(state, row)
  }

  /** Every chat without readers is let go: its watch stops, its children are no longer followed. */
  #sweep(): Effect.Effect<void> {
    const left = [...this.#chats.values()].filter((state) => state.rows.size === 0)
    return Effect.forEach(
      left,
      (state) => {
        this.#chats.delete(state.chat)
        this.#sessions.delete(state.session)
        return Effect.andThen(this.#unwatch(state), this.#children.released(state.chat))
      },
      { discard: true },
    )
  }

  /** The chat whose stream `message` is about, when it has a watch of `message.gen`. */
  #current(message: { readonly chat: string; readonly gen: number }): ChatState | undefined {
    const state = this.#chats.get(message.chat)
    return state?.gen === message.gen ? state : undefined
  }

  /** The watch went quiet: it stops, unless a batch came or a run goes on; its readers stay connected. */
  #onIdle(message: Extract<Message, { kind: 'idle' }>): Effect.Effect<void> {
    const state = this.#current(message)
    if (state === undefined || state.lastBatchAt !== message.at || busy(state)) return Effect.void
    return this.#unwatch(state)
  }

  /** A commit of a session without a watch: a chat with readers is watched again, a child is followed again. */
  #onCommit(session: string): Effect.Effect<void, AppError> {
    const chat = this.#sessions.get(session)
    if (chat === undefined) return this.#children.committed(session)
    const state = this.#chats.get(chat)
    return state === undefined || state.watch !== undefined || state.attaching ? Effect.void : this.#attach(state)
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
      case 'idle':
        return this.#onIdle(message)
      case 'closed': {
        const state = this.#current(message)
        if (state !== undefined) this.#watching.delete(state.session)
        if (state !== undefined) state.watch = undefined
        return Effect.void
      }
      case 'join':
        return this.#onJoin(message).pipe(Effect.catch((error) => Deferred.fail(message.done, error)))
      case 'attach': {
        const state = this.#chats.get(message.chat)
        return state?.attaching === true ? this.#attach(state) : Effect.void
      }
      case 'leave':
        return Effect.sync(() => this.#onLeave(message.chat, message.row))
      case 'child-batch':
      case 'child-closed':
      case 'child-idle':
      case 'invocations':
      case 'conversations':
        return this.#children.handle(message)
    }
  }
}
