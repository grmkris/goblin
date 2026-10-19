// Source replies use owner-reviewed result rules, frozen calls and durable piece progress (ADR 0072).
// Tool acceptance is not external delivery. Only an explicit retryable result authorizes another dispatch.
import type { SourceReply } from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Forbidden } from '../http/errors.ts'
import { REPLY_WINDOW } from './delivery.ts'
import { topicOf } from './messages.ts'
import { acceptPiece, dispatchPiece, planReply, savedReplyPlan, type ReplyPlan } from './reply-plan.ts'
import { sinkOutcome, sinkRetryAt, type SinkOutcome } from './sink-result.ts'
import {
  type ReplyRow,
  type SourceRow,
  dueReplies,
  reportedReply,
  retryReply,
  routeOf,
  routeRow,
  settleReply,
  setupOf,
  sourceRow,
} from './store.ts'
import type { Answer, ReplyRef } from './turns.ts'
import type { EngineContext, SourceDelivery, SourcePorts } from './types.ts'

export const REPLY_TRIES = 5
const PAUSED_RETRY = 300
const backoff = (attempts: number) => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1))
type Report = (delivery: SourceDelivery) => Effect.Effect<void>
type Terminal = NonNullable<ReplyRow['outcome']>

/** Each attempt's truthful outcome and accepted-piece count, with no content in the ledger or flows. */
const report = (context: EngineContext, reply: ReplyRow, delivered: Report, outcome: string, pieces: number) =>
  Effect.gen(function* () {
    const error = outcome === 'accepted' ? {} : { [RunAttribute.errorType]: outcome }
    yield* context.record(
      'source.reply',
      {
        operationId: reply.operationId,
        chatId: reply.chatId ?? undefined,
      },
      reply.createdAt * 1000,
      { [RunAttribute.delivery]: outcome, [RunAttribute.pieces]: pieces, ...error },
    )
    yield* delivered({
      operationId: reply.operationId,
      pieces,
      ...(outcome === 'accepted' ? {} : { errorType: outcome }),
    })
  })

/** Terminal failures are visible to the owner and are never automatically resent. */
const finish = (
  context: EngineContext,
  reply: ReplyRow,
  ports: SourcePorts,
  delivered: Report,
  terminal: { readonly outcome: Terminal; readonly pieces: number; readonly connectionId: string },
) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const { outcome, pieces, connectionId } = terminal
    settleReply(context.db, reply.operationId, outcome, now)
    yield* report(context, reply, delivered, outcome, pieces)
    if (outcome === 'accepted') return reportedReply(context.db, reply.operationId)
    const label = yield* ports.label(connectionId)
    const route = routeRow(context.db, reply.sourceId, reply.key)
    const words = {
      rejected: `The reply tool rejected goblin's answer to ${label}. It was not retried.`,
      unknown: `goblin cannot confirm whether its answer reached ${label}. It was not retried.`,
      given_up: `goblin's answer to ${label} stopped after its retry or waiting limit.`,
    }
    yield* ports.notice({
      id: `notice:${reply.operationId}:${outcome}`,
      sourceId: reply.sourceId,
      connectionId,
      label,
      topic: route === undefined ? undefined : topicOf(routeOf(route)),
      title: words[outcome],
      body: `${String(pieces)} reply pieces were accepted by the tool; this does not prove external delivery.`,
    })
    reportedReply(context.db, reply.operationId)
  })

/** Source state and the exact reviewed settings are rechecked after MCP connection/credential waits. */
const authorize = (context: EngineContext, reply: ReplyRow, plan: ReplyPlan) =>
  Effect.suspend(() => {
    const source = sourceRow(context.db, reply.sourceId)
    return source?.state === 'active' &&
      source.revision === reply.sourceRevision &&
      source.binding === reply.sourceBinding &&
      source.setup === plan.setup &&
      source.connectionId === plan.connectionId
      ? Effect.void
      : Effect.fail(new Forbidden({ reason: 'source reply setup changed' }))
  })

type Attempt = { readonly outcome: SinkOutcome; readonly retryAt?: number }

/** Transport uncertainty is terminal; only the producer's reviewed structured retry rule can permit a retry. */
const attempt = (context: EngineContext, reply: ReplyRow, plan: ReplyPlan, ports: SourcePorts, index: number) =>
  ports.send(plan.connectionId, plan.tool, plan.calls[index] ?? {}, authorize(context, reply, plan)).pipe(
    Effect.map((result): Attempt => ({
      outcome: sinkOutcome(result, plan.result),
      retryAt: sinkRetryAt(result, plan.result),
    })),
    Effect.catchTags({
      Forbidden: () => Effect.succeed<Attempt>({ outcome: 'rejected' }),
      ResidentInactive: () => Effect.succeed<Attempt>({ outcome: 'rejected' }),
    }),
    // expected: a transport/protocol failure cannot establish whether the external side effect happened.
    Effect.catch(() => Effect.succeed<Attempt>({ outcome: 'unknown' })),
  )

/**
 * A piece the producer's result says to retry: given up at the last try, else tried again after its backoff (or at its
 * `retryAt` when later), within the reply's window.
 */
const retryPiece = (
  context: EngineContext,
  reply: ReplyRow,
  ports: SourcePorts,
  delivered: Report,
  piece: { readonly index: number; readonly retryAt: number | undefined; readonly connectionId: string },
) =>
  Effect.gen(function* () {
    const attempts = reply.attempts + 1
    if (attempts >= REPLY_TRIES)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'given_up',
        pieces: piece.index,
        connectionId: piece.connectionId,
      })
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    retryReply(
      context.db,
      reply.operationId,
      attempts,
      Math.min(
        reply.createdAt + REPLY_WINDOW,
        Math.max(now + backoff(attempts), Math.ceil((piece.retryAt ?? 0) / 1000)),
      ),
    )
    return yield* report(context, reply, delivered, 'retryable', piece.index)
  })

/** Frozen calls resume at the first unaccepted piece. Each acknowledgement is committed before the next dispatch. */
const sendPieces = (context: EngineContext, reply: ReplyRow, plan: ReplyPlan, ports: SourcePorts, delivered: Report) =>
  Effect.gen(function* () {
    for (let index = reply.nextPiece; index < plan.calls.length; index += 1) {
      if (Math.floor((yield* Clock.currentTimeMillis) / 1000) >= reply.createdAt + REPLY_WINDOW)
        return yield* finish(context, reply, ports, delivered, {
          outcome: 'given_up',
          pieces: index,
          connectionId: plan.connectionId,
        })
      if (!dispatchPiece(context.db, reply.operationId, index)) return
      const result = yield* attempt(context, reply, plan, ports, index)
      if (result.outcome === 'accepted') {
        acceptPiece(context.db, reply.operationId, index)
        continue
      }
      if (result.outcome !== 'retryable')
        return yield* finish(context, reply, ports, delivered, {
          outcome: result.outcome,
          pieces: index,
          connectionId: plan.connectionId,
        })
      return yield* retryPiece(context, reply, ports, delivered, {
        index,
        retryAt: result.retryAt,
        connectionId: plan.connectionId,
      })
    }
    yield* finish(context, reply, ports, delivered, {
      outcome: 'accepted',
      pieces: plan.calls.length,
      connectionId: plan.connectionId,
    })
  })

/** How a reply ends before another piece goes out: its outcome and how many pieces were accepted by then. */
type Settled = { readonly outcome: Terminal; readonly pieces: number }

/**
 * Where a due reply stands before it sends: settled when it already has an outcome, has every piece accepted, was
 * interrupted mid-dispatch (unknown), is past its window or has lost its Source or reply rule (given up), or its Source
 * changed since (rejected); else the Source row and reply rule it goes out by.
 */
const standingOf = (
  reply: ReplyRow,
  saved: ReplyPlan | undefined,
  row: SourceRow | undefined,
  now: number,
): Settled | { readonly row: SourceRow; readonly rule: SourceReply } => {
  const rule = row === undefined ? undefined : setupOf(row)?.reply
  if (reply.outcome !== null) return { outcome: reply.outcome, pieces: reply.nextPiece }
  if (saved !== undefined && reply.nextPiece >= saved.calls.length)
    return { outcome: 'accepted', pieces: saved.calls.length }
  if (reply.dispatching) return { outcome: 'unknown', pieces: reply.nextPiece }
  if (now >= reply.createdAt + REPLY_WINDOW || row === undefined || rule === undefined)
    return { outcome: 'given_up', pieces: reply.nextPiece }
  if (row.revision !== reply.sourceRevision || row.binding !== reply.sourceBinding)
    return { outcome: 'rejected', pieces: reply.nextPiece }
  return { row, rule }
}

const sendReply = (
  context: EngineContext,
  reply: ReplyRow,
  answer: Answer | undefined,
  ports: SourcePorts,
  delivered: Report,
) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const saved = savedReplyPlan(reply)
    const row = sourceRow(context.db, reply.sourceId)
    const connectionId = saved?.connectionId ?? row?.connectionId ?? ''
    const standing = standingOf(reply, saved, row, now)
    if ('outcome' in standing) return yield* finish(context, reply, ports, delivered, { ...standing, connectionId })
    const { row: source, rule } = standing
    if (source.state !== 'active') {
      return retryReply(
        context.db,
        reply.operationId,
        reply.attempts,
        Math.min(reply.createdAt + REPLY_WINDOW, now + PAUSED_RETRY),
      )
    }
    const plan = saved ?? (answer === undefined ? undefined : planReply(context.db, reply, source, rule, answer.text))
    if (plan === undefined)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'unknown',
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    yield* sendPieces(context, reply, plan, ports, delivered)
  })

/** Which turn `reply` answers: its operation, and the chat and Persona when it has them. */
const refOf = (reply: ReplyRow): ReplyRef => ({
  operationId: reply.operationId,
  ...(reply.chatId === null ? {} : { chatId: reply.chatId }),
  ...(reply.personaId === null ? {} : { personaId: reply.personaId }),
})

/** Source wake is single-flight in the live service; a retained dispatch intent therefore means process interruption. */
export const deliverReplies = (context: EngineContext, ports: SourcePorts, delivered: Report) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    let waiting = false
    for (const reply of dueReplies(context.db, now)) {
      if (reply.outcome !== null || reply.plan !== null || reply.dispatching || now >= reply.createdAt + REPLY_WINDOW) {
        yield* sendReply(context, reply, undefined, ports, delivered)
        continue
      }
      const answer = yield* ports.answer(refOf(reply))
      if (answer === undefined) waiting = true
      else yield* sendReply(context, reply, answer, ports, delivered)
    }
    return waiting
  })
