import type { AgentEvent, AgentEventStream } from '@earendil-works/pi-durable'
import type { PersonaAvatar, PersonaFailure, PersonaInvocationView } from '@goblin/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import { chatRow } from '../chats/directory.ts'
import { type AppError, attempt } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { type PiSessions, fromPi } from '../pi/sessions.ts'
import { appConversations } from '../storage/schema.ts'
import type { ChildSent, StreamCursor, Translation } from './agui.ts'
import { childBatch, childEnded, childFound } from './children.ts'
import type { ChildEnd, ChildInfo } from './lifecycle.ts'

// The producer's children (docs/architecture/streams.md): the chats whose work a joined chat's streams carry, a
// Persona's fork from its invocation's start to its end, and an open subagent's runs. Each is followed by a watch of
// its own while it works, its batches carried in every stream of its parent through `children.ts`. Every method runs in
// the producer's fiber, so what it keeps needs no lock.

/** How long a child's watch outlives its last batch once its parent's streams carry nothing of it. */
const IDLE_MS = 30_000

/** A Persona at the revision its invocation froze: what its `SUBAGENT_*` events name. */
export type PersonaAt = { readonly name: string; readonly avatar: PersonaAvatar }

/** What the producer's fiber takes for its children, in order with the rest. */
export type ChildMessage =
  | {
      readonly kind: 'child-batch'
      readonly child: string
      readonly gen: number
      readonly events: readonly AgentEvent[]
    }
  | { readonly kind: 'child-closed'; readonly child: string; readonly gen: number }
  | { readonly kind: 'child-idle'; readonly child: string; readonly gen: number; readonly at: number }
  /** Invocations as each change left them, read when it was made: a later read may find one settled already. */
  | { readonly kind: 'invocations'; readonly views: readonly PersonaInvocationView[] }
  | { readonly kind: 'conversations'; readonly ids: readonly string[] }

/** What following children needs of the agent: Pi, the chat rows, the Persona invocations and revisions. */
export type ChildPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly pi: PiSessions['Service']
  readonly scope: Scope.Scope
  /** Hands a message to the producer's fiber. */
  readonly offer: (message: ChildMessage) => void
  readonly working: (chat: string) => Effect.Effect<readonly PersonaInvocationView[]>
  readonly invocation: (operationId: string, persona: number) => Effect.Effect<PersonaInvocationView | undefined>
  readonly persona: (id: number, revision: number) => Effect.Effect<PersonaAt | undefined>
  /** The entry of the prompt an invocation asked its fork with, once it is placed: where its work begins. */
  readonly promptEntry: (fork: string, operationId: string, persona: number) => Effect.Effect<number | undefined>
}

/** What the producer lends its children: which chats have streams, what they carry, and a step over their cursors. */
export type ParentPorts = {
  readonly streamed: (chat: string) => boolean
  /** The children the chat's streams carry now, each as one of them has it. */
  readonly carried: (chat: string) => ReadonlyMap<string, ChildSent>
  /** `step` over the cursor of each of the chat's streams, what it answers appended in each one's tier. */
  readonly step: (chat: string, step: (cursor: StreamCursor) => Translation) => Effect.Effect<void>
}

/** A child the producer follows: who it is, its parent, whether its runs are its work (a subagent), and its watch. */
type ChildWatch = {
  info: ChildInfo
  readonly parent: string
  readonly runs: boolean
  /** Bumped by every new watch: a batch of an older one is stale. */
  gen: number
  watch?: AgentEventStream | undefined
  lastBatchAt: number
  /** The newest entry its watches delivered: where a subagent's next run is carried from. */
  seen: number
}

/** The newest entry among `events`, or `seen` when they hold none newer. */
function newest(seen: number, events: readonly AgentEvent[]): number {
  let at = seen
  for (const event of events) {
    if (event.type === 'message_end' || event.type === 'entry_appended') at = Math.max(at, Number(event.entry.id))
    if (event.type === 'snapshot') for (const { id } of event.entries) at = Math.max(at, Number(id))
  }
  return at
}

/** Why a Persona gave no answer, as a person reads it on its `SUBAGENT_ERROR`. */
const FAILED: Readonly<Record<PersonaFailure, string>> = {
  no_answer: 'It gave no answer.',
  model_error: 'Its model call failed.',
  budget: "The day's model budget is spent.",
  unavailable: 'It could not answer.',
}

/** How a settled invocation ends its fork's work: failed with why, stopped, or answered with its entry. */
function settledEnd(view: PersonaInvocationView): ChildEnd | undefined {
  if (view.state === 'stopped') return { outcome: 'stopped' }
  if (view.state === 'answered')
    return { outcome: 'success', ...(view.answerEntry === undefined ? {} : { entryId: view.answerEntry }) }
  if (view.state !== 'failed') return undefined
  const reason = view.reason ?? 'unavailable'
  return { outcome: 'failed', code: reason, message: FAILED[reason], reason }
}

/** The subagents open under `chat`: the ones its streams follow the runs of. */
const openSubagents = (db: DrizzleSqliteDODatabase, chat: string) =>
  db
    .select({ chat: appConversations.chatId, title: appConversations.title })
    .from(appConversations)
    .where(
      and(
        eq(appConversations.parentSession, chat),
        eq(appConversations.kind, 'subagent'),
        isNull(appConversations.closedAt),
      ),
    )
    .all()

/** A subagent as its parent's stream names it. */
const subagentInfo = (chat: string, title: string | null): ChildInfo => ({ chat, name: title ?? 'subagent' })

/** The children of the producer's chats: their watches, by child chat, and every one's Pi session. */
export class ChildFollow {
  readonly #ports: ChildPorts
  readonly #parent: ParentPorts
  readonly #children = new Map<string, ChildWatch>()
  constructor(ports: ChildPorts, parent: ParentPorts) {
    this.#ports = ports
    this.#parent = parent
  }

  /** Whether `session` is a child's with no watch, which its commit starts. A child's chat is its session. */
  idle(session: string): boolean {
    const child = this.#children.get(session)
    return child !== undefined && child.watch === undefined
  }

  /** A commit of a child's session: a watch follows it again. */
  committed(session: string): Effect.Effect<void, AppError> {
    const child = this.#children.get(session)
    return child === undefined || child.watch !== undefined ? Effect.void : this.#follow(child)
  }

  /**
   * The parent's watch began anew: its children as the agent has them now, each followed and carried in every one of
   * its streams (a new epoch starts them, the others catch up), and those it carried that are gone ended.
   */
  attached(parent: string): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const live = yield* this.#live(parent)
      for (const child of live) yield* this.#follow(child)
      const known = new Set(live.map(({ info }) => info.chat))
      for (const [chat, child] of this.#parent.carried(parent))
        if (!known.has(chat)) yield* this.#gone(parent, chat, child)
      yield* this.settled(parent)
    })
  }

  /**
   * The parent's streams moved on (a batch of its, a new watch): a Persona's fork they no longer carry (its answer
   * ended its work there) is done with, and its watch stops.
   */
  settled(parent: string): Effect.Effect<void> {
    const carried = this.#parent.carried(parent)
    const done = [...this.#children.values()].filter(
      (child) => child.parent === parent && !child.runs && !carried.has(child.info.chat),
    )
    return Effect.forEach(done, (child) => this.#drop(child), { discard: true })
  }

  /** One message, in the producer's fiber. */
  handle(message: ChildMessage): Effect.Effect<void, AppError> {
    switch (message.kind) {
      case 'child-batch':
        return this.#onBatch(message)
      case 'child-closed': {
        const child = this.#current(message)
        if (child !== undefined) child.watch = undefined
        return Effect.void
      }
      case 'child-idle':
        return this.#onIdle(message)
      case 'invocations':
        return Effect.forEach(message.views, (view) => this.#onInvocation(view), { discard: true })
      case 'conversations':
        return Effect.forEach(message.ids, (id) => this.#onConversation(id), { discard: true })
    }
  }

  /** The children of `parent` that work now: Personas answering in their forks, and open subagents. */
  #live(parent: string): Effect.Effect<readonly ChildWatch[], AppError> {
    return Effect.gen({ self: this }, function* () {
      const found: ChildWatch[] = []
      for (const view of yield* this.#ports.working(parent)) {
        const info = yield* this.#personaInfo(view)
        if (info !== undefined) found.push(this.#ensure(info, parent, false))
      }
      const subagents = yield* attempt(async () => openSubagents(this.#ports.db, parent))
      for (const { chat, title } of subagents) found.push(this.#ensure(subagentInfo(chat, title), parent, true))
      return found
    })
  }

  /** The child's watch, made or with its name brought up to date (a resumed Persona answers for a new operation). */
  #ensure(info: ChildInfo, parent: string, runs: boolean): ChildWatch {
    const known = this.#children.get(info.chat)
    if (known !== undefined) {
      known.info = info
      return known
    }
    const child: ChildWatch = { info, parent, runs, gen: 0, lastBatchAt: 0, seen: 0 }
    this.#children.set(info.chat, child)
    return child
  }

  /** A Persona's fork as its parent's stream names it: the Persona at its invocation's revision, for its operation. */
  #personaInfo(view: PersonaInvocationView): Effect.Effect<ChildInfo | undefined> {
    const { fork } = view
    if (fork === undefined) return Effect.succeed(undefined)
    return Effect.map(this.#ports.persona(view.persona, view.revision), (at) =>
      at === undefined
        ? undefined
        : {
            chat: fork,
            name: at.name,
            persona: {
              id: view.persona,
              name: at.name,
              revision: view.revision,
              avatar: at.avatar,
              operationId: view.operationId,
            },
          },
    )
  }

  /** A new watch of the child: it is carried in its parent's streams from the watch's snapshot, then batch by batch. */
  #follow(child: ChildWatch): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.#unwatch(child)
      const stream = yield* fromPi(this.#ports.pi.events(child.info.chat))
      const { snapshot } = stream
      child.seen = newest(child.seen, [snapshot])
      child.lastBatchAt = yield* Clock.currentTimeMillis
      this.#listen(child, stream)
      const after = yield* this.#promptOf(child)
      const from = { snapshot, after: after === undefined ? undefined : after - 1 }
      yield* this.#parent.step(child.parent, (cursor) => childFound(cursor, child.info, from, child.runs))
      yield* this.#settle(child)
    })
  }

  /**
   * Where a Persona's work begins in its fork: its invocation's prompt, once placed (the fork may have worked already
   * when its start is taken, or answered before, for an earlier invocation). None for a subagent, or one carried.
   */
  #promptOf(child: ChildWatch): Effect.Effect<number | undefined> {
    const { persona, chat } = child.info
    if (persona === undefined || this.#carried(child)) return Effect.succeed(undefined)
    return this.#ports.promptEntry(chat, persona.operationId, persona.id)
  }

  /** Its batches and its end come in through the producer's fiber, with the watch's generation. */
  #listen(child: ChildWatch, stream: AgentEventStream): void {
    const { offer } = this.#ports
    const { chat } = child.info
    const { gen } = child
    child.watch = stream
    stream.start(async (events) => {
      offer({ kind: 'child-batch', child: chat, gen, events })
      await Promise.resolve()
    })
    const ended = () => offer({ kind: 'child-closed', child: chat, gen })
    stream.closed.then(ended, ended)
  }

  /** Stops the child's watch, if it has one; a batch it still delivers is stale. */
  #unwatch(child: ChildWatch): Effect.Effect<void> {
    child.gen += 1
    const old = child.watch
    child.watch = undefined
    if (old === undefined) return Effect.void
    return attempt(() => old.stop()).pipe(Effect.asVoid, reportAndRecover('streams.unwatch', undefined))
  }

  /** The child's watch or message of `message.gen`, when it is still the child's current one. */
  #current(message: { readonly child: string; readonly gen: number }): ChildWatch | undefined {
    const child = this.#children.get(message.child)
    return child?.gen === message.gen ? child : undefined
  }

  /** Whether the parent's streams still carry the child's work. */
  #carried(child: ChildWatch): boolean {
    return this.#parent.carried(child.parent).has(child.info.chat)
  }

  /**
   * After a batch or a new watch: a Persona's fork its parent no longer carries is done with (its answer ended it);
   * any other child waits for its next batch, and a watch with nothing carried stops after `IDLE_MS`.
   */
  #settle(child: ChildWatch): Effect.Effect<void> {
    if (this.#carried(child)) return Effect.void
    if (!child.runs) return this.#drop(child)
    const message: ChildMessage = { kind: 'child-idle', child: child.info.chat, gen: child.gen, at: child.lastBatchAt }
    return Effect.asVoid(
      Effect.forkIn(
        Effect.andThen(
          Effect.sleep(IDLE_MS),
          Effect.sync(() => this.#ports.offer(message)),
        ),
        this.#ports.scope,
      ),
    )
  }

  /** The child is no longer followed. */
  #drop(child: ChildWatch): Effect.Effect<void> {
    this.#children.delete(child.info.chat)
    return this.#unwatch(child)
  }

  /** One batch of the child's watch, carried in each of its parent's streams. */
  #onBatch(message: Extract<ChildMessage, { kind: 'child-batch' }>): Effect.Effect<void> {
    const child = this.#current(message)
    if (child === undefined) return Effect.void
    return Effect.gen({ self: this }, function* () {
      child.lastBatchAt = yield* Clock.currentTimeMillis
      const rule = { runs: child.runs, after: child.seen }
      child.seen = newest(child.seen, message.events)
      yield* this.#parent.step(child.parent, (cursor) => childBatch(cursor, child.info, message.events, rule))
      yield* this.#settle(child)
    })
  }

  /** The child's watch went quiet with nothing of it carried: it stops until the child's next commit. */
  #onIdle(message: Extract<ChildMessage, { kind: 'child-idle' }>): Effect.Effect<void> {
    const child = this.#current(message)
    if (child === undefined || child.lastBatchAt !== message.at || this.#carried(child)) return Effect.void
    return this.#unwatch(child)
  }

  /** An invocation started, or settled: its fork is followed in the chat it was asked in, or its work ends there. */
  #onInvocation(view: PersonaInvocationView): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const { fork } = view
      if (fork === undefined || !this.#parent.streamed(view.chat)) return
      if (view.state === 'running') {
        const info = yield* this.#personaInfo(view)
        if (info !== undefined) yield* this.#follow(this.#ensure(info, view.chat, false))
        return
      }
      // An answer ends its fork's work where the stream carries the answer; a failed or stopped one ends it now.
      const end = settledEnd(view)
      if (end !== undefined && view.state !== 'answered')
        yield* this.#parent.step(view.chat, (cursor) => childEnded(cursor, fork, end))
      yield* this.settled(view.chat)
    })
  }

  /** A chat changed: a subagent newly open under a chat with streams is followed, one closed is done with. */
  #onConversation(id: string): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const row = yield* attempt(async () => chatRow(this.#ports.db, id))
      const parent = row?.parentSession ?? null
      if (row?.kind !== 'subagent' || parent === null || !this.#parent.streamed(parent)) return
      const known = this.#children.get(id)
      if (row.closedAt === null) {
        if (known === undefined) yield* this.#follow(this.#ensure(subagentInfo(id, row.title), parent, true))
        return
      }
      const end: ChildEnd = row.closedBy === 'owner' ? { outcome: 'stopped' } : { outcome: 'success' }
      yield* this.#parent.step(parent, (cursor) => childEnded(cursor, id, end))
      if (known !== undefined) yield* this.#drop(known)
    })
  }

  /**
   * A child the parent's streams carry that no longer works (it settled or closed while the agent was away): a
   * Persona's ends as its invocation did, a subagent's as done.
   */
  #gone(parent: string, chat: string, child: ChildSent): Effect.Effect<void, AppError> {
    return Effect.gen({ self: this }, function* () {
      const { persona } = child
      const view = persona === undefined ? undefined : yield* this.#ports.invocation(persona.operationId, persona.id)
      const end = view === undefined ? { outcome: 'success' as const } : settledEnd(view)
      if (end !== undefined) yield* this.#parent.step(parent, (cursor) => childEnded(cursor, chat, end))
    })
  }
}
