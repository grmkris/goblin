import {
  type CreateTopic,
  EVERYTHING,
  PERSONAL_TOPIC,
  type TopicSeedData,
  type TopicSetup,
  type TopicSummary,
  type TopicView,
  type UpdateTopic,
} from '@goblin/contracts'
import { and, asc, desc, eq, getTableColumns, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Effect from 'effect/Effect'
import { type AppError, Conflict, InvalidInput, NotFound, attemptSync } from '../http/errors.ts'
import { makerColumn, makerOf, reachedIds } from '../keys/reach.ts'
import { after, pageOf } from '../storage/page.ts'
import { appTopics } from '../storage/topics.ts'
import { storedSetup, topicSetupOf } from './setup.ts'

type Row = typeof appTopics.$inferSelect

/** Who made a Topic: the owner (UI) or the agent (its organize tools, on a direct request). */
export type TopicActor = 'owner' | 'agent'

/**
 * What a new Topic's Conversation needs beyond this table, injected so the registry is tested without Pi: `open` makes
 * a new Pi session for a Topic with that setup (never a fork of Personal's Conversation) and answers its id; `register` lists
 * it in the chat registry as the Topic's Conversation, and `retitle` keeps its title the Topic's name, each inside the
 * registry's transaction; `touched` tells the conversations' listeners about a Conversation either wrote, after it;
 * `activate` turns its memory on (once; repeating it does nothing).
 */
export type TopicPorts = {
  readonly open: (setup: TopicSetup) => Effect.Effect<string, AppError>
  readonly register: (chat: string, topic: number, name: string, now: number) => void
  readonly retitle: (chat: string, name: string) => void
  readonly touched: (chats: readonly string[]) => Effect.Effect<void, AppError>
  readonly activate: (chat: string) => Effect.Effect<void, AppError>
  /** Writes a Topic's seed into its Conversation once per operation (a passive write; it starts no run). */
  readonly seed: (chat: string, operationId: string, seed: TopicSeedData) => Effect.Effect<void, AppError>
}

/** A Topic's row with the key that made it, when one did (ADR 0108). */
type Made = Row & { readonly maker: string | null | undefined }

/** Who made a room: the key, by name (ADR 0108). */
const roomOf = (maker: string | null | undefined) =>
  maker === null || maker === undefined ? {} : { room: { key: maker } }

const view = (row: Made): TopicView => ({
  id: row.id,
  name: row.name,
  ...(row.description === '' ? {} : { description: row.description }),
  ...(row.instructions === '' ? {} : { instructions: row.instructions }),
  conversation: row.chatId,
  ...(row.id === PERSONAL_TOPIC ? { personal: true } : {}),
  ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
  searchExcluded: row.searchExcluded,
  revision: row.revision,
  setup: topicSetupOf(row.setup),
  ...roomOf(row.maker),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
})

const summary = (row: Made): TopicSummary => ({
  id: row.id,
  name: row.name,
  conversation: row.chatId,
  ...(row.id === PERSONAL_TOPIC ? { personal: true } : {}),
  revision: row.revision,
  archived: row.archivedAt !== null,
  searchExcluded: row.searchExcluded,
  ...roomOf(row.maker),
  updatedAt: row.updatedAt,
})

/** Which page of Topics: after `cursor`, at most `limit`, and only key `key`'s own when it names one (ADR 0084). */
export type TopicPageQuery = { readonly key?: string; readonly cursor?: string; readonly limit: number }

/** A name as stored: runs of whitespace become one space, ends trimmed; nothing left is refused. */
const cleanName = (name: string): string => {
  const clean = name.replaceAll(/\s+/gu, ' ').trim()
  if (clean === '') throw new InvalidInput({ reason: 'topic_name' })
  return clean
}

/** Guidance edits must name the revision they replace; other edits may opt into the same check. */
function checkGuidanceRevision(change: UpdateTopic, revision: number): void {
  if ((change.description !== undefined || change.instructions !== undefined) && change.expectedRevision === undefined)
    throw new InvalidInput({ reason: 'revision_required' })
  if (change.expectedRevision !== undefined && revision !== change.expectedRevision)
    throw new Conflict({ reason: 'revision' })
}

/**
 * The owner's Topics (ADR 0032), as rows: a store with no state of its own. Personal (id 1) is seeded by the migration
 * with Main as its Conversation; every other Topic gets a new Pi session as its Conversation when it is created.
 * Creating is idempotent by operation id; the Topics service serializes it (`topics/service.ts`), so a concurrent repeat
 * finds the one Topic and its one Pi session, and tells the change bus what each write changed. Archive here only marks
 * the Topic; stopping its chats' work is the caller's (`topics/program.ts`), through the owner's Stop.
 */
export class TopicRegistry<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #ports: TopicPorts

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, ports: TopicPorts) {
    this.#db = db
    this.#ports = ports
  }

  #row(id: number): Row {
    const row = this.#db.select().from(appTopics).where(eq(appTopics.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'topic' })
    return row
  }

  /** Topics with the key that made each, one statement for any number of them. */
  #made() {
    return this.#db.select({ ...getTableColumns(appTopics), maker: makerColumn('topic', appTopics.id) }).from(appTopics)
  }

  /** A row just read or written, with the key that made it. */
  #view(row: Row): TopicView {
    return view({ ...row, maker: makerOf(this.#db, 'topic', row.id) })
  }

  /** Every Topic, archived ones included, in creation order (Personal first). */
  list(): readonly TopicView[] {
    return this.#made().orderBy(asc(appTopics.id)).all().map(view)
  }

  get(id: number): TopicView {
    return this.#view(this.#row(id))
  }

  /** A page of Topics, newest change first; archived ones too. */
  page(query: TopicPageQuery): { readonly topics: readonly TopicSummary[]; readonly next?: string } {
    const rows = this.#made()
      .where(
        and(
          query.key === undefined ? undefined : inArray(appTopics.id, reachedIds(this.#db, query.key, 'topic')),
          after(appTopics, query.cursor),
        ),
      )
      .orderBy(desc(appTopics.updatedAt), desc(appTopics.id))
      .limit(query.limit + 1)
      .all()
    const page = pageOf(rows, query.limit)
    return { topics: page.rows.map(summary), ...(page.next === undefined ? {} : { next: page.next }) }
  }

  /** Whether the Topic is archived: its chats take no new work until it is restored. */
  archived(id: number): boolean {
    return this.#row(id).archivedAt !== null
  }

  /** Refuses `name` while another active Topic has it, ignoring case. */
  #assertFree(name: string, except?: number): void {
    const clash = this.#db
      .select({ id: appTopics.id })
      .from(appTopics)
      .where(
        and(
          sql`${appTopics.name} = ${name} COLLATE NOCASE`,
          isNull(appTopics.archivedAt),
          ...(except === undefined ? [] : [ne(appTopics.id, except)]),
        ),
      )
      .get()
    if (clash !== undefined) throw new Conflict({ reason: 'topic_name_taken' })
  }

  /**
   * A new Topic named `name` with a new Conversation and `setup` (everything when none is given), or the Topic
   * `operationId` already made (whatever its name and setup now).
   * The name is checked before the Pi session is made, so a clash leaves nothing behind. A Topic made from a discussion
   * (the organize tools) starts with `seed`, its brief and frozen excerpts, as an `app.topic_seed` entry. Two creates
   * at once are the caller's to serialize: each would make a Pi session before the other's row exists.
   */
  create(
    input: CreateTopic,
    actor: TopicActor,
    now: number,
    seed?: TopicSeedData,
  ): Effect.Effect<{ readonly topic: TopicView; readonly created: boolean }, AppError> {
    const db = this.#db
    const ports = this.#ports
    const assertFree = (name: string) => this.#assertFree(name)
    const viewOf = (row: Row) => this.#view(row)
    /** Turns the Conversation's memory on, then writes the seed it was made with, if any; both are idempotent. */
    const ready = (chat: string) =>
      Effect.andThen(ports.activate(chat), seed === undefined ? Effect.void : ports.seed(chat, input.operationId, seed))
    return Effect.gen(function* () {
      const existing = db.select().from(appTopics).where(eq(appTopics.operationId, input.operationId)).get()
      if (existing !== undefined) {
        // A retry finishes what a failed first attempt began: the Conversation's memory and its seed.
        yield* ready(existing.chatId)
        return { topic: viewOf(existing), created: false }
      }
      const name = yield* attemptSync(() => {
        const clean = cleanName(input.name)
        assertFree(clean)
        return clean
      })
      const chat = yield* ports.open(input.setup ?? EVERYTHING)
      const row = yield* attemptSync(() =>
        db.transaction(() => {
          assertFree(name)
          const [inserted] = db
            .insert(appTopics)
            .values({
              name,
              description: input.description?.trim() ?? '',
              instructions: input.instructions?.trim() ?? '',
              chatId: chat,
              operationId: input.operationId,
              setup: storedSetup(input.setup ?? EVERYTHING),
              createdBy: actor,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .all()
          if (inserted === undefined) throw new Conflict({ reason: 'topic_not_created' })
          ports.register(chat, inserted.id, name, now)
          return inserted
        }),
      )
      yield* ports.touched([chat])
      yield* ready(chat)
      return { topic: viewOf(row), created: true }
    })
  }

  /** Tells the conversations' listeners that `update` retitled a Topic's Conversation. */
  retitled(chat: string): Effect.Effect<void, AppError> {
    return this.#ports.touched([chat])
  }

  /**
   * Rename, archive or restore, and opt in or out of automatic search, as one change with one new revision. Personal is
   * never archived; a rename or restore onto a name another active Topic has is a `Conflict`. Nothing changed is no
   * write.
   */
  update(id: number, change: UpdateTopic, now: number): TopicView {
    const row = this.#row(id)
    checkGuidanceRevision(change, row.revision)
    if (change.archived === true && id === PERSONAL_TOPIC) throw new InvalidInput({ reason: 'personal_topic' })
    const name = change.name === undefined ? row.name : cleanName(change.name)
    const description = change.description?.trim() ?? row.description
    const instructions = change.instructions?.trim() ?? row.instructions
    const archivedAt = change.archived === undefined ? row.archivedAt : change.archived ? (row.archivedAt ?? now) : null
    const searchExcluded = change.searchExcluded ?? row.searchExcluded
    if (
      name === row.name &&
      description === row.description &&
      instructions === row.instructions &&
      archivedAt === row.archivedAt &&
      searchExcluded === row.searchExcluded
    )
      return this.#view(row)
    const updated = this.#db.transaction(() => {
      if (archivedAt === null) this.#assertFree(name, id)
      const [next] = this.#db
        .update(appTopics)
        .set({
          name,
          description,
          instructions,
          archivedAt,
          searchExcluded,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(appTopics.id, id), eq(appTopics.revision, row.revision)))
        .returning()
        .all()
      if (next === undefined) throw new Conflict({ reason: 'revision' })
      if (name !== row.name) this.#ports.retitle(row.chatId, name)
      return next
    })
    return this.#view(updated)
  }

  /**
   * A new setup (ADR 0040) as one new revision, compare-and-set on `expectedRevision` when it is given (else `Conflict`
   * `revision`). The same setup is no write.
   */
  setSetup(id: number, setup: TopicSetup, expectedRevision: number | undefined, now: number): TopicView {
    const row = this.#row(id)
    if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Conflict({ reason: 'revision' })
    const stored = storedSetup(setup)
    if (stored === row.setup) return this.#view(row)
    const [next] = this.#db
      .update(appTopics)
      .set({ setup: stored, revision: row.revision + 1, updatedAt: now })
      .where(and(eq(appTopics.id, id), eq(appTopics.revision, row.revision)))
      .returning()
      .all()
    if (next === undefined) throw new Conflict({ reason: 'revision' })
    return this.#view(next)
  }
}
