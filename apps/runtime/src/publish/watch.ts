import type { CommitPublication } from '@earendil-works/pi-durable'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import { chatOfSession, chatRow } from '../chats/directory.ts'
import type { AppError } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { touchedSessions } from '../streams/producer.ts'
import type { ConversationUpdated } from '@goblin/contracts'
import { dueAt } from './event.ts'
import type { AttentionFold } from './payload.ts'
import { clearDirty, listened, markDirty, record } from './journal.ts'

// What notices that a chat changed (ADR 0112): Pi's commits and Persona invocations name chats, one fiber takes them
// in turn, and each chat is looked at a little later (`dueAt`): at most once a second, never while nothing listens.
// A change is noted in `app_publish_dirty` first, so one an eviction cut off is looked at after the restart.

/** What the watch's one fiber takes, in order. */
export type WatchMessage =
  | { readonly kind: 'sessions'; readonly sessions: readonly string[] }
  | { readonly kind: 'chats'; readonly chats: readonly string[] }
  | { readonly kind: 'look'; readonly chat: string }

/** A chat as it reads now: the payload of its wake, and its attention fold after reading it. */
export type ChatReading = { readonly data: ConversationUpdated; readonly fold: AttentionFold }

export type WatchPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly scope: Scope.Scope
  readonly queue: Queue.Queue<WatchMessage>
  /** What `chat` says now, from `fold` (none: read from its start); none when the chat is gone. */
  readonly read: (chat: string, fold: AttentionFold | undefined) => Effect.Effect<ChatReading | undefined, AppError>
  /** Deliveries were queued: they go out now. */
  readonly queued: Effect.Effect<void>
  /** A fresh occurrence id. */
  readonly newId: Effect.Effect<string, AppError>
}

/** A chat the watch knows: whether a look is armed, when its last wake went out, and its attention fold. */
type Known = { armed: boolean; sentAt: number; fold?: AttentionFold | undefined }

/** How far up a chat's parents the watch walks to the chat a child's work counts for. */
const DEPTH = 8

/**
 * The chat a change of `chat` is about: itself, or for a Persona's fork or a subagent the chat it works for, the
 * nearest one up that is neither. None for a chat that is not registered.
 */
export function subjectOf(db: DrizzleSqliteDODatabase, chat: string): string | undefined {
  let row = chatRow(db, chat)
  for (let depth = 0; row !== undefined && depth < DEPTH; depth += 1) {
    if (row.role !== 'persona' && row.kind !== 'subagent') return row.chatId
    row = row.parentSession === null ? undefined : chatRow(db, row.parentSession)
  }
  return undefined
}

/** The watch: its chats, and what its fiber does with each message. Every method runs in the fiber's turn. */
export class Watch {
  readonly #ports: WatchPorts
  readonly #chats = new Map<string, Known>()
  constructor(ports: WatchPorts) {
    this.#ports = ports
  }

  /** Pi's commit, inside it: the sessions it touched are noted, nothing more. */
  noticed(publication: CommitPublication): void {
    const sessions = touchedSessions(publication)
    if (sessions.size > 0) Queue.offerUnsafe(this.#ports.queue, { kind: 'sessions', sessions: [...sessions] })
  }

  /** Chats some other write changed (a Persona's invocation, a subagent opened or closed). */
  changed(chats: readonly string[]): Effect.Effect<void> {
    return chats.length === 0 ? Effect.void : Effect.asVoid(Queue.offer(this.#ports.queue, { kind: 'chats', chats }))
  }

  /** The fiber's work: every message in turn; one that fails is reported and the next one taken. */
  get run(): Effect.Effect<never> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.#ports.queue), (message) =>
        Effect.suspend(() => this.#handle(message)).pipe(reportAndRecover('publish.watch', undefined)),
      ),
    )
  }

  #known(chat: string): Known {
    const known = this.#chats.get(chat) ?? { armed: false, sentAt: Number.NEGATIVE_INFINITY }
    this.#chats.set(chat, known)
    return known
  }

  /** `chat` changed: unless nothing listens, it waits to be looked at, and a look is armed for it once. */
  #touch(chat: string): Effect.Effect<void> {
    const subject = subjectOf(this.#ports.db, chat)
    if (subject === undefined) return Effect.void
    const known = this.#known(subject)
    if (known.armed) return Effect.void
    return Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (!listened(this.#ports.db, now)) return Effect.void
      markDirty(this.#ports.db, subject, now)
      return this.#arm(subject, known, now)
    })
  }

  #arm(chat: string, known: Known, now: number): Effect.Effect<void> {
    known.armed = true
    const look = Effect.andThen(
      Effect.sleep(dueAt(now, known.sentAt) - now),
      Queue.offer(this.#ports.queue, { kind: 'look', chat }),
    )
    return Effect.asVoid(Effect.forkIn(look, this.#ports.scope))
  }

  /** A chat looked at: its wake journaled and owed to its listeners when it says something new. */
  #look(chat: string): Effect.Effect<void, AppError> {
    const known = this.#known(chat)
    known.armed = false
    const { db, read, queued, newId } = this.#ports
    return Effect.gen(function* () {
      const reading = yield* read(chat, known.fold)
      if (reading === undefined) return yield* Effect.sync(() => clearDirty(db, chat))
      known.fold = reading.fold
      const at = yield* Clock.currentTimeMillis
      const eventId = yield* newId
      const recorded = yield* Effect.sync(() => record(db, { data: reading.data, eventId, at }))
      if (recorded === undefined) return
      known.sentAt = at
      if (recorded.queued > 0) yield* queued
    })
  }

  /** Every chat that waits to be looked at (after a restart): each looked at soon. */
  resume(chats: readonly string[]): Effect.Effect<void> {
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.forEach(chats, (chat) => this.#arm(chat, this.#known(chat), now), { discard: true }),
    )
  }

  #handle(message: WatchMessage): Effect.Effect<void, AppError> {
    switch (message.kind) {
      case 'sessions':
        return Effect.forEach(
          message.sessions,
          (session) => {
            const chat = chatOfSession(this.#ports.db, session)
            return chat === undefined ? Effect.void : this.#touch(chat)
          },
          { discard: true },
        )
      case 'chats':
        return Effect.forEach(message.chats, (chat) => this.#touch(chat), { discard: true })
      case 'look':
        return this.#look(message.chat)
    }
  }
}
