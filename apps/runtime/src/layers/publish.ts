import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import { chatRow } from '../chats/directory.ts'
import { Conversations } from '../chats/service.ts'
import { attempt, toAppError } from '../http/errors.ts'
import { Cipher } from '../mcp/oauth/cipher.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { Invocations } from '../personas/service.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import { drain } from '../publish/deliver.ts'
import { type AttentionFold, foldAttention, wakeOf } from '../publish/payload.ts'
import { dirtyChats, nextPrune, pruneJournal } from '../publish/journal.ts'
import { endExpired, nextDue, pruneOrphans } from '../publish/leases.ts'
import { Published, leasesOf } from '../publish/service.ts'
import { Watch, type ChatReading, type WatchMessage } from '../publish/watch.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { appConversations } from '../storage/schema.ts'

/** A fixture's first retry delay, when it sets one (`PUBLISH_RETRY_MS`). */
const retryMsOf = (value: string | undefined): number | undefined => {
  const ms = Number(value)
  return value === undefined || !Number.isSafeInteger(ms) || ms < 1 ? undefined : ms
}

/** How deep and how many subagents under a chat its activity looks at. */
const HELPER_DEPTH = 3
const HELPERS = 32

/** The Pi sessions of the open subagents under `chat`, theirs under them too, within the bounds. */
function openHelpers(db: DrizzleSqliteDODatabase, chat: string): readonly string[] {
  const sessions: string[] = []
  let parents = [chat]
  for (let depth = 0; depth < HELPER_DEPTH && parents.length > 0 && sessions.length < HELPERS; depth += 1) {
    const rows = db
      .select({ chat: appConversations.chatId, session: appConversations.piSession })
      .from(appConversations)
      .where(
        and(
          inArray(appConversations.parentSession, parents),
          eq(appConversations.kind, 'subagent'),
          isNull(appConversations.closedAt),
        ),
      )
      .limit(HELPERS)
      .all()
    for (const row of rows) if (row.session !== null) sessions.push(row.session)
    parents = rows.map((row) => row.chat)
  }
  return sessions.slice(0, HELPERS)
}

/**
 * How a chat reads now for its wake, from Pi: its entries since the fold (or all of them, once), and whether it, a
 * Persona answering in it or one of its subagents is at work; what that says is `publish/payload.ts`'s.
 */
const chatReader = Effect.gen(function* () {
  const db = yield* Db
  const pi = yield* PiSessions
  const conversations = yield* Conversations
  const invocations = yield* Invocations
  const seed = (chat: string, session: string) =>
    Effect.map(fromPi(pi.messages(session)), (entries) => foldAttention(chat, undefined, entries))
  const advance = (chat: string, session: string, fold: AttentionFold | undefined) =>
    fold === undefined
      ? seed(chat, session)
      : conversations.after(chat, fold.last).pipe(
          Effect.map((entries) => foldAttention(chat, fold, entries)),
          // A fold more than a forward read behind (a long eviction) reads the chat from its start again.
          Effect.catchTag('Conflict', () => seed(chat, session)),
        )
  const working = (chat: string, session: string) =>
    Effect.gen(function* () {
      if (yield* fromPi(pi.busy(session))) return true
      if ((yield* invocations.live).some((each) => each.chat === chat)) return true
      for (const helper of openHelpers(db, chat)) if (yield* fromPi(pi.busy(helper))) return true
      return false
    })
  return (chat: string, fold: AttentionFold | undefined) =>
    Effect.gen(function* () {
      const row = chatRow(db, chat)
      if (row?.piSession === undefined || row.piSession === null) return undefined
      const next = yield* advance(chat, row.piSession, fold)
      const busy = yield* working(chat, row.piSession)
      return { fold: next, data: wakeOf({ chat, topicId: row.topicId }, next, busy) } satisfies ChatReading
    })
})

/**
 * The MCP Events goblin publishes (ADR 0112): the watch's fiber and the drains in the runtime's scope, Pi's commits and
 * Persona invocations noticed from the start, every chat a restart left waiting looked at again, and the wake that
 * sends what is due and ends what ran out.
 */
export const PublishLive = Layer.effect(
  Published,
  Effect.gen(function* () {
    const { publishFetch, schedulePublish, env } = yield* AgentInput
    const db = yield* Db
    const cipher = yield* Cipher
    const flights = yield* SingleFlight
    const scope = yield* Effect.scope
    const newId = (yield* Crypto.Crypto)
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => toAppError(cause, 'publish.id')))
    const due = Effect.sync(() => {
      const times = [nextDue(db), nextPrune(db)].filter((at): at is number => at !== undefined)
      return times.length === 0 ? undefined : Math.min(...times)
    })
    const arm = Effect.flatMap(due, (at) => (at === undefined ? Effect.void : attempt(() => schedulePublish(at))))
    const sendDue = Effect.asVoid(
      flights.skip(
        'publish.drain',
        drain({ db, cipher, send: publishFetch, newId, retryMs: retryMsOf(env.PUBLISH_RETRY_MS) }),
      ),
    )
    const kick = Effect.asVoid(
      Effect.forkIn(Effect.andThen(sendDue, arm).pipe(reportAndRecover('publish.kick', undefined)), scope),
    )
    const queue = yield* Queue.unbounded<WatchMessage>()
    const watch = new Watch({ db, scope, queue, read: yield* chatReader, queued: kick, newId })
    yield* Effect.forkScoped(watch.run)
    yield* noticing(watch).pipe(reportAndRecover('publish.start', undefined))
    yield* watch.resume(dirtyChats(db))
    const maintain = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        endExpired(db, now)
        pruneJournal(db, now)
        pruneOrphans(db)
      })
      yield* sendDue
      yield* arm
    }).pipe(Effect.withSpan('Published.maintain'))
    return Published.of({ ...leasesOf({ db, cipher, send: publishFetch, kick, arm, newId }), maintain, nextDue: due })
  }),
)

/** Pi's commits from now on, Persona invocations as they move and chats as they open and close, all to `watch`. */
const noticing = (watch: Watch) =>
  Effect.gen(function* () {
    const pi = yield* PiSessions
    const harness = yield* fromPi(pi.pi)
    const unsubscribe = harness.subscribeCommits((publication) => watch.noticed(publication))
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    const changes = yield* Changes
    const invocations = yield* Invocations
    // Each invocation's chat, read in the writer's step; the watch only takes its note.
    yield* changes.on('invocations.changed', ({ ids }) =>
      Effect.forEach(ids, ({ operationId, persona }) => invocations.get(operationId, persona)).pipe(
        Effect.flatMap((found) => watch.changed(found.flatMap(Option.toArray).map((view) => view.chat))),
      ),
    )
    yield* changes.on('conversations.changed', ({ ids }) => watch.changed(ids))
  })
