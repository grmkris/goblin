import type { InspectFlowsInput } from '@goblin/contracts/inspect'
import { RunAttribute, RunAttributes, RunEvent, RunEventKind, RunEventStatus } from '@goblin/contracts/telemetry'
import { and, asc, desc, eq, gte, inArray, lt, like, or, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { appRunEvents } from '../storage/schema.ts'
import { boundAttributes, type RunSink } from './events.ts'
import { incompleteAnswer, needsAttention } from './attention.ts'
import { expectedFailure } from './safety.ts'

/** How long the ledger keeps an event (ADR 0024). */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const isKind = Schema.is(RunEventKind)
const decodeStatus = Schema.decodeUnknownSync(RunEventStatus)
const decodeAttributes = Schema.decodeUnknownSync(Schema.fromJsonString(RunAttributes))

type Row = typeof appRunEvents.$inferSelect

/** A row of a kind this build does not know (a newer build wrote it) is `undefined`, never a failed read. */
const eventOf = (row: Row): RunEvent | undefined =>
  isKind(row.kind)
    ? {
        id: row.id,
        kind: row.kind,
        status: decodeStatus(row.status),
        ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
        ...(row.operationId === null ? {} : { operationId: row.operationId }),
        ...(row.taskId === null ? {} : { taskId: row.taskId }),
        startedAt: row.startedAt,
        ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
        attributes: boundAttributes(decodeAttributes(row.attributes)),
      }
    : undefined

/**
 * Attributes only the deployment's own logs and traces keep (ADR 0107): its model endpoint's host and port. The ledger
 * drops them, so inspection, which reads only the ledger, never answers them to an owner or a credential.
 */
const OPERATOR_ONLY: ReadonlySet<string> = new Set([RunAttribute.serverAddress, RunAttribute.serverPort])

const ledgerAttributes = (attributes: RunEvent['attributes']): RunEvent['attributes'] =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => !OPERATOR_ONLY.has(key)))

const rowOf = (event: RunEvent): Row => ({
  id: event.id,
  kind: event.kind,
  status: event.status,
  conversationId: event.conversationId ?? null,
  operationId: event.operationId ?? null,
  taskId: event.taskId ?? null,
  startedAt: event.startedAt,
  endedAt: event.endedAt ?? null,
  attributes: JSON.stringify(ledgerAttributes(event.attributes)),
})

/** An attribute equals `value`: its JSON path quotes the key, whose dots are part of the name. */
const attributeIs = (key: string, value: string | number) =>
  sql`json_extract(${appRunEvents.attributes}, ${`$."${key}"`}) = ${value}`

/**
 * Above every character an operation id can hold after `prefix`: ids that start with `prefix` sort between it and
 * `prefix` with this added. A range, not a LIKE pattern, since Cloudflare's SQLite refuses a pattern over 50 bytes and
 * an operation id runs to 200.
 */
const PAST = '\u{10FFFF}'
/** Bound on the operations one read links to another. */
const RELATED = 20

/** Leave room for fixed query parameters below Workers SQLite's 100-parameter limit. */
const PROBLEM_PAGE_SIZE = 64
/** The most rows a filtered read looks at (`keep`), newest first, before it answers what it kept. */
export const KEPT_SCAN_ROWS = 4096

/** Which events a read answers: those `keep` keeps, of every row it looks at. */
export type Keep = (event: RunEvent) => boolean

/** Rows older than `before` in newest-first order (`started_at`, then `id`); every row without it. */
const olderThan = (before: Row | undefined) =>
  before === undefined
    ? undefined
    : or(
        lt(appRunEvents.startedAt, before.startedAt),
        and(eq(appRunEvents.startedAt, before.startedAt), lt(appRunEvents.id, before.id)),
      )

/**
 * The agent's run ledger in its own SQLite (`app_run_events`). Writes are single statements, never held across an
 * await, so they are safe inside Pi's synchronous commit listener. Reads skip rows of a kind this build does not know,
 * so a rollback past a new kind still reads the rest; `skipped` counts them.
 */
export class RunLedger<RunResult = unknown> implements RunSink {
  readonly name = 'ledger'
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  #skipped = 0

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>) {
    this.#db = db
  }

  /** Rows the reads of this ledger skipped because their kind is unknown here. */
  get skipped(): number {
    return this.#skipped
  }

  started(event: RunEvent): void {
    this.#write(event)
  }

  ended(event: RunEvent): void {
    this.#write(event)
  }

  /** The event `id`, in whatever state it was last written. */
  read(id: string): RunEvent | undefined {
    const row = this.#db.select().from(appRunEvents).where(eq(appRunEvents.id, id)).get()
    return row === undefined ? undefined : this.#events([row])[0]
  }

  /** The newest event of `kind` for a Pi task: the model attempt a response answers, after a restart too. */
  latestForTask(kind: RunEventKind, taskId: string): RunEvent | undefined {
    const row = this.#db
      .select()
      .from(appRunEvents)
      .where(and(eq(appRunEvents.taskId, taskId), eq(appRunEvents.kind, kind)))
      .orderBy(desc(appRunEvents.startedAt))
      .limit(1)
      .get()
    return row === undefined ? undefined : this.#events([row])[0]
  }

  /** Every event of one turn, in the order they started. */
  forOperation(operationId: string): readonly RunEvent[] {
    return this.#events(
      this.#db
        .select()
        .from(appRunEvents)
        .where(eq(appRunEvents.operationId, operationId))
        .orderBy(asc(appRunEvents.startedAt), asc(appRunEvents.id))
        .all(),
    )
  }

  /** The events of several turns, for their summaries. */
  forOperations(operationIds: readonly string[]): readonly RunEvent[] {
    if (operationIds.length === 0) return []
    return this.#events(
      this.#db
        .select()
        .from(appRunEvents)
        .where(inArray(appRunEvents.operationId, [...operationIds]))
        .all(),
    )
  }

  /** Turns that started since `since`, newest first, optionally in one conversation and only those `keep` keeps. */
  turns(since: number, limit: number, conversationId?: string, keep?: Keep): readonly RunEvent[] {
    const conversation = conversationId === undefined ? [] : [eq(appRunEvents.conversationId, conversationId)]
    return this.#newest(
      (before, size) =>
        this.#db
          .select()
          .from(appRunEvents)
          .where(
            and(
              eq(appRunEvents.kind, 'turn.submitted'),
              gte(appRunEvents.startedAt, since),
              olderThan(before),
              ...conversation,
            ),
          )
          .orderBy(desc(appRunEvents.startedAt), desc(appRunEvents.id))
          .limit(size)
          .all(),
      limit,
      keep,
    )
  }

  /**
   * Flow steps (kind `flow`) that started since `since`, newest first, optionally of one chat or one flow and only
   * those `keep` keeps.
   */
  flows(
    since: number,
    limit: number,
    filter: Pick<InspectFlowsInput, 'chat' | 'flow'> = {},
    keep?: Keep,
  ): readonly RunEvent[] {
    return this.#newest(
      (before, size) =>
        this.#db
          .select()
          .from(appRunEvents)
          .where(
            and(
              eq(appRunEvents.kind, 'flow'),
              gte(appRunEvents.startedAt, since),
              olderThan(before),
              filter.chat === undefined ? undefined : attributeIs(RunAttribute.chat, filter.chat),
              filter.flow === undefined ? undefined : attributeIs(RunAttribute.flow, filter.flow),
            ),
          )
          .orderBy(desc(appRunEvents.startedAt), desc(appRunEvents.id))
          .limit(size)
          .all(),
      limit,
      keep,
    )
  }

  /**
   * Up to `limit` events of `page`'s rows, newest first. Without `keep`, one read of `limit` rows; with it, pages of
   * rows until `limit` are kept, the rows run out or {@link KEPT_SCAN_ROWS} were looked at.
   */
  #newest(page: (before: Row | undefined, size: number) => readonly Row[], limit: number, keep?: Keep): RunEvent[] {
    if (keep === undefined) return this.#events(page(undefined, limit))
    const kept: RunEvent[] = []
    let before: Row | undefined
    for (let scanned = 0; kept.length < limit && scanned < KEPT_SCAN_ROWS;) {
      const rows = page(before, PROBLEM_PAGE_SIZE)
      kept.push(
        ...this.#events(rows)
          .filter(keep)
          .slice(0, limit - kept.length),
      )
      scanned += rows.length
      if (rows.length < PROBLEM_PAGE_SIZE) break
      before = rows.at(-1)
    }
    return kept
  }

  /**
   * The operation whose model answer or tool result is entry `entry` of Pi session `session`: the events that recorded
   * it name the entry (`goblin.entry`). A message no turn wrote (the owner's own, a passive write) has none here.
   */
  operationOfEntry(session: string, entry: number): string | undefined {
    const row = this.#db
      .select({ operationId: appRunEvents.operationId })
      .from(appRunEvents)
      .where(
        and(
          eq(appRunEvents.conversationId, session),
          inArray(appRunEvents.kind, ['model.attempt', 'tool.call']),
          attributeIs(RunAttribute.entry, entry),
        ),
      )
      .orderBy(desc(appRunEvents.startedAt))
      .limit(1)
      .get()
    return row?.operationId ?? undefined
  }

  /** Flow steps that name `operationId` as the operation that caused them (`goblin.operation.parent`). */
  childFlows(operationId: string): readonly RunEvent[] {
    return this.#events(
      this.#db
        .select()
        .from(appRunEvents)
        .where(and(eq(appRunEvents.kind, 'flow'), attributeIs(RunAttribute.parentOperation, operationId)))
        .orderBy(asc(appRunEvents.startedAt))
        .limit(RELATED)
        .all(),
    )
  }

  /** Recorded operation ids that start with `prefix`: the ids an operation's own steps derive from it. */
  operationsStarting(prefix: string): readonly string[] {
    return this.#db
      .selectDistinct({ operationId: appRunEvents.operationId })
      .from(appRunEvents)
      .where(and(gte(appRunEvents.operationId, prefix), lt(appRunEvents.operationId, `${prefix}${PAST}`)))
      .limit(RELATED)
      .all()
      .flatMap((row) => (row.operationId === null ? [] : [row.operationId]))
  }

  /**
   * Events that failed, were blocked or were cut short since `since`, newest first; with `keep`, only those it keeps,
   * of at most {@link KEPT_SCAN_ROWS} rows.
   */
  problems(since: number, limit: number, all = false, keep?: Keep): readonly RunEvent[] {
    const problems: RunEvent[] = []
    const bound = keep === undefined ? Number.POSITIVE_INFINITY : KEPT_SCAN_ROWS
    let before: Row | undefined
    for (let scanned = 0; problems.length < limit && scanned < bound;) {
      const rows = this.#problemPage(since, before)
      scanned += rows.length
      const candidates = this.#events(rows).filter(
        (event) =>
          ((event.status !== 'ok' && event.status !== 'started') || incompleteAnswer(event)) &&
          (keep === undefined || keep(event)),
      )
      const peers = all ? [] : this.#successfulAttempts(candidates)
      problems.push(
        ...candidates.filter((event) => all || needsAttention(event, peers)).slice(0, limit - problems.length),
      )
      // Page by rows, not events: a skipped row still moves the cursor and still counts towards a full page.
      if (rows.length < PROBLEM_PAGE_SIZE) break
      before = rows.at(-1)
    }
    return problems
  }

  #problemPage(since: number, before?: Row): readonly Row[] {
    const cursor = olderThan(before)
    return this.#db
      .select()
      .from(appRunEvents)
      .where(
        and(
          gte(appRunEvents.startedAt, since),
          cursor,
          or(
            inArray(appRunEvents.status, ['error', 'blocked', 'interrupted']),
            and(
              eq(appRunEvents.kind, 'model.attempt'),
              or(
                like(appRunEvents.attributes, '%"goblin.cutoff":true%'),
                like(appRunEvents.attributes, '%"goblin.empty_answer":true%'),
                like(appRunEvents.attributes, '%"gen_ai.response.finish_reasons"%"length"%'),
              ),
            ),
            like(appRunEvents.attributes, '%"goblin.coverage_gap":true%'),
          ),
        ),
      )
      .orderBy(desc(appRunEvents.startedAt), desc(appRunEvents.id))
      .limit(PROBLEM_PAGE_SIZE)
      .all()
  }

  #successfulAttempts(events: readonly RunEvent[]): readonly RunEvent[] {
    const taskIds = events.flatMap((event) =>
      event.kind === 'model.attempt' &&
      event.taskId !== undefined &&
      event.status !== 'ok' &&
      event.status !== 'started' &&
      !incompleteAnswer(event) &&
      !expectedFailure(event.attributes['error.type'])
        ? [event.taskId]
        : [],
    )
    if (taskIds.length === 0) return []
    return this.#events(
      this.#db
        .select()
        .from(appRunEvents)
        .where(
          and(
            eq(appRunEvents.kind, 'model.attempt'),
            eq(appRunEvents.status, 'ok'),
            inArray(appRunEvents.taskId, taskIds),
          ),
        )
        .all(),
    )
  }

  /**
   * At start, before any new work: whatever was still `started` belonged to the previous run of this object and
   * stopped with it, so it is `interrupted`. Events past retention go. Returns how many were interrupted.
   */
  sweep(now: number): number {
    const interrupted = this.#db
      .update(appRunEvents)
      .set({ status: 'interrupted', endedAt: now })
      .where(eq(appRunEvents.status, 'started'))
      .returning({ id: appRunEvents.id })
      .all().length
    this.#db
      .delete(appRunEvents)
      .where(lt(appRunEvents.startedAt, now - LEDGER_RETENTION_MS))
      .run()
    return interrupted
  }

  #events(rows: readonly Row[]): RunEvent[] {
    return rows.flatMap((row) => {
      const event = eventOf(row)
      if (event === undefined) this.#skipped += 1
      return event === undefined ? [] : [event]
    })
  }

  #write(event: RunEvent): void {
    const row = rowOf(event)
    this.#db.insert(appRunEvents).values(row).onConflictDoUpdate({ target: appRunEvents.id, set: row }).run()
  }
}
