// Source replies use owner-reviewed result rules, frozen calls and durable piece progress (ADR 0072).
// Tool acceptance is not external delivery. Only an explicit retryable result authorizes another dispatch.
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
  dueReplies,
  reportedReply,
  retryReply,
  routeOf,
  routeRow,
  settleReply,
  setupOf,
  sourceRow,
} from './store.ts'
import type { Answer } from './turns.ts'
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
      const attempts = reply.attempts + 1
      if (attempts >= REPLY_TRIES)
        return yield* finish(context, reply, ports, delivered, {
          outcome: 'given_up',
          pieces: index,
          connectionId: plan.connectionId,
        })
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      retryReply(
        context.db,
        reply.operationId,
        attempts,
        Math.min(
          reply.createdAt + REPLY_WINDOW,
          Math.max(now + backoff(attempts), Math.ceil((result.retryAt ?? 0) / 1000)),
        ),
      )
      return yield* report(context, reply, delivered, 'retryable', index)
    }
    yield* finish(context, reply, ports, delivered, {
      outcome: 'accepted',
      pieces: plan.calls.length,
      connectionId: plan.connectionId,
    })
  })

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
    const setup = row === undefined ? undefined : setupOf(row)
    const connectionId = saved?.connectionId ?? row?.connectionId ?? ''
    if (reply.outcome !== null)
      return yield* finish(context, reply, ports, delivered, {
        outcome: reply.outcome,
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    if (saved !== undefined && reply.nextPiece >= saved.calls.length)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'accepted',
        pieces: saved.calls.length,
        connectionId: connectionId,
      })
    if (reply.dispatching)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'unknown',
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    if (now >= reply.createdAt + REPLY_WINDOW || row === undefined || setup?.reply === undefined)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'given_up',
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    if (row.revision !== reply.sourceRevision || row.binding !== reply.sourceBinding)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'rejected',
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    if (row.state !== 'active') {
      return retryReply(
        context.db,
        reply.operationId,
        reply.attempts,
        Math.min(reply.createdAt + REPLY_WINDOW, now + PAUSED_RETRY),
      )
    }
    const plan =
      saved ?? (answer === undefined ? undefined : planReply(context.db, reply, row, setup.reply, answer.text))
    if (plan === undefined)
      return yield* finish(context, reply, ports, delivered, {
        outcome: 'unknown',
        pieces: reply.nextPiece,
        connectionId: connectionId,
      })
    yield* sendPieces(context, reply, plan, ports, delivered)
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
      const answer = yield* ports.answer({
        operationId: reply.operationId,
        ...(reply.chatId === null ? {} : { chatId: reply.chatId }),
        ...(reply.personaId === null ? {} : { personaId: reply.personaId }),
      })
      if (answer === undefined) waiting = true
      else yield* sendReply(context, reply, answer, ports, delivered)
    }
    return waiting
  })
