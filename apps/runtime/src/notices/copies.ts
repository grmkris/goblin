// A notice's copy through Notify me via (ADR 0070): the words frozen when the notice was claimed, sent once per attempt
// with a stable operation id through the sink as it was at the first attempt. Losing resident authority, the sink (it
// changed or was cleared), a tool set to Ask first or the server's refusal suppresses it, and so does a sink on the
// connection the notice's event came from; any other failure is tried again with backoff and fails after five attempts
// or fifteen minutes. The remote receipt is kept apart from acceptance.
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Forbidden } from '../http/errors.ts'
import { reportFailure } from '../observability/report.ts'
import { isRecord, sha256Hex } from '../runtime/digest.ts'
import { notifySink, sendThroughSink, sinkRevision } from '../sources/notify.ts'
import { Notices } from './service.ts'
import type { NoticeRow } from './store.ts'

/** How many attempts a copy gets, and for how long after its notice it may still go (ADR 0041). */
const ATTEMPTS = 5
const WINDOW = 900_000

/** The parts of a server's answer kept as the copy's remote receipt, each only when it has this shape. */
const RECEIPT = {
  id: Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Finite]),
  delivery: Schema.String.check(Schema.isMaxLength(40)),
}

/**
 * The remote receipt of an accepted copy: its operation id, and the server's `id` and `delivery` when its structured
 * answer has them; any other field, or one of another shape, is left out (servers answer as they like).
 */
const receiptOf = (operationId: string, structured: unknown): string => {
  const answer = isRecord(structured) ? structured : {}
  const kept = Object.entries(RECEIPT).flatMap(([key, schema]) =>
    Option.match(Schema.decodeUnknownOption(schema)(answer[key]), {
      onNone: () => [],
      onSome: (value) => [[key, value] as const],
    }),
  )
  return JSON.stringify({ operationId, ...Object.fromEntries(kept) })
}

type Delivery = { readonly state: 'accepted' | 'suppressed' | 'pending'; readonly receipt: string | null }
const suppress = () => Effect.succeed<Delivery>({ state: 'suppressed', receipt: null })

/** One attempt at `row`'s copy, recorded with how it ended. */
const deliver = (row: NoticeRow) =>
  Effect.gen(function* () {
    const notices = yield* Notices
    const at = yield* Clock.currentTimeMillis
    const text = row.copyText
    if (text === null) return
    const sink = yield* notifySink
    const current = sink === undefined ? null : yield* sinkRevision(sink)
    // The first attempt freezes the sink as it is now; a later one goes only to that same sink.
    const revision = row.copySink ?? current
    if (row.copyAttempts >= ATTEMPTS || at >= row.createdAt + WINDOW)
      return yield* notices.copyDone(row.id, { state: 'failed', receipt: null, nextAt: 0, attempt: row.copyAttempts })
    if (!(yield* notices.claimCopy(row.id, row.copyAttempts, revision, at))) return
    const operationId = `notice-${(yield* Effect.promise(() => sha256Hex(row.id))).slice(0, 32)}`
    const delivery = yield* Effect.gen(function* () {
      if (sink === undefined || revision === null || current !== revision)
        return yield* new Forbidden({ reason: 'notify sink changed' })
      // A notice of the sink's own connection's event never goes back there, whenever the sink was set.
      if (row.connectionId === sink.connectionId) return yield* new Forbidden({ reason: 'notice echo' })
      const result = yield* sendThroughSink({ revision, text, operationId, timeout: 5000 })
      if (result.isError === true) return yield* new Forbidden({ reason: 'notice refused' })
      return receiptOf(operationId, result.structuredContent)
    }).pipe(
      Effect.map((receipt): Delivery => ({ state: 'accepted', receipt })),
      Effect.catchTags({ ResidentInactive: suppress, Forbidden: suppress }),
      reportFailure('notices.copy'),
      // expected: reported above; a failed attempt is tried again with backoff and fails after five attempts.
      Effect.catch(() => Effect.succeed<Delivery>({ state: 'pending', receipt: null })),
    )
    const attempt = row.copyAttempts + 1
    const spent = attempt >= ATTEMPTS || at >= row.createdAt + WINDOW
    yield* notices.copyDone(row.id, {
      state: delivery.state === 'pending' && spent ? 'failed' : delivery.state,
      receipt: delivery.receipt,
      nextAt: at + Math.min(15_000 * 2 ** attempt, 300_000),
      attempt,
    })
  })

/** The copies due now, each tried once; true when some still wait for a retry. */
export const deliverNoticeCopies = Effect.gen(function* () {
  const due = yield* (yield* Notices).copiesDue(yield* Clock.currentTimeMillis)
  for (const row of due) yield* deliver(row)
  return due.length > 0
})
