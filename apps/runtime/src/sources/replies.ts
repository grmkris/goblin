// A Source's answers going back (ADR 0066): once the turn a message made has settled, its answer goes out through the
// reply tool in pieces of `maxChars`, each with a stable operation id so the producer can deduplicate retries.
// Successful MCP acceptance does not prove external delivery or exactly-once effects. A failed send is tried again
// later; after five tries it is given up with a notice.
import { type SourceKeyValues, fillTemplate } from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { failureAttributes, outcomeOf } from '../telemetry/attributes.ts'
import { deliverReady } from './delivery.ts'
import { asArguments, topicOf } from './messages.ts'
import {
  type ReplyRow,
  dueReplies,
  retryReply,
  routeOf,
  routeRow,
  settleReply,
  setupOf,
  sourceRow,
  valuesOf,
} from './store.ts'
import { chunks, operationIdOf } from './text.ts'
import type { Answer } from './turns.ts'
import type { EngineContext, SourceDelivery, SourcePorts } from './types.ts'

/** How many times an answer is tried before it is given up. */
export const REPLY_TRIES = 5
/** How long an answer a paused Source owes waits before it is looked at again, in seconds. */
const PAUSED_RETRY = 300

/** How long after `attempts` failed tries an answer is tried again, in seconds: a minute, doubling, at most an hour. */
const backoff = (attempts: number) => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1))

/** The arguments of one piece of an answer: its words, its own operation id and the conversation it goes back to. */
const replyArguments = (template: Record<string, unknown>, values: SourceKeyValues, piece: string, id: string) =>
  asArguments(
    fillTemplate(template, {
      text: piece,
      operationId: id,
      ...Object.fromEntries(Object.entries(values).map(([name, value]) => [`key.${name}`, value])),
    }),
  )

/** What a delivery reports: it to the flows, and a line to the run ledger. */
type Report = (delivery: SourceDelivery) => Effect.Effect<void>

/**
 * A failed try of `reply`: tried again after a backoff, or given up after five with a notice to the owner where its
 * conversation puts notes.
 */
const failedTry = (context: EngineContext, reply: ReplyRow, connectionId: string, ports: SourcePorts, now: number) =>
  Effect.gen(function* () {
    const attempts = reply.attempts + 1
    if (attempts < REPLY_TRIES) return retryReply(context.db, reply.operationId, attempts, now + backoff(attempts))
    settleReply(context.db, reply.operationId, 'given_up', now)
    const label = yield* ports.label(connectionId)
    const route = routeRow(context.db, reply.sourceId, reply.key)
    yield* ports.notice({
      id: `notice:${reply.operationId}:given-up`,
      sourceId: reply.sourceId,
      connectionId,
      label,
      topic: route === undefined ? undefined : topicOf(routeOf(route)),
      title: `goblin's answer could not be sent back to ${label} after ${String(REPLY_TRIES)} tries`,
    })
  })

/** One answer through the reply tool: in pieces, each with its own operation id; given up as `answer` says. */
const sendReply = (
  context: EngineContext,
  reply: ReplyRow,
  answer: Answer | undefined,
  ports: SourcePorts,
  delivered: Report,
) =>
  Effect.gen(function* () {
    const { db, record } = context
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const ref = { operationId: reply.operationId, chatId: reply.chatId ?? undefined }
    const row = sourceRow(db, reply.sourceId)
    const setup = row === undefined ? undefined : setupOf(row)
    if (row === undefined || setup?.reply === undefined || answer === undefined) {
      settleReply(db, reply.operationId, 'given_up', now)
      yield* record('source.reply', ref, reply.createdAt * 1000, { [RunAttribute.delivery]: 'given_up' })
      return yield* delivered({ operationId: reply.operationId, pieces: 0 })
    }
    // A paused Source keeps what it owes until it runs again, or the day is out: it is looked at again in a while.
    if (row.state !== 'active') return retryReply(db, reply.operationId, reply.attempts, now + PAUSED_RETRY)
    const { tool, arguments: template, maxChars } = setup.reply
    const values = valuesOf(routeRow(db, row.id, reply.key) ?? { keyValues: '{}' })
    const pieces = chunks(answer.text, maxChars)
    const sent = { [RunAttribute.delivery]: 'sent', [RunAttribute.pieces]: pieces.length }
    const sends = Effect.forEach(
      pieces.entries(),
      ([index, piece]) =>
        ports.call(
          row.connectionId,
          tool,
          replyArguments(template, values, piece, operationIdOf(`reply-${String(index)}`, reply.operationId)),
        ),
      { discard: true },
    )
    yield* sends.pipe(
      Effect.andThen(Effect.sync(() => settleReply(db, reply.operationId, 'sent', now))),
      Effect.andThen(record('source.reply', ref, reply.createdAt * 1000, sent)),
      Effect.andThen(delivered({ operationId: reply.operationId, pieces: pieces.length })),
      // expected: a failed send is recorded and tried again later, and given up with a notice after five tries.
      Effect.catch((error) =>
        Effect.all([
          record('source.reply', ref, reply.createdAt * 1000, { ...sent, ...failureAttributes(error) }),
          delivered({ operationId: reply.operationId, pieces: pieces.length, errorType: outcomeOf(error) }),
          failedTry(context, reply, row.connectionId, ports, now),
        ]),
      ),
    )
  })

/** Sends every answer that is due, each one on its own (one failing does not hold up the rest); true while some run. */
export const deliverReplies = (context: EngineContext, ports: SourcePorts, delivered: Report) =>
  Effect.flatMap(Clock.currentTimeMillis, (millis) => {
    const now = Math.floor(millis / 1000)
    return deliverReady(dueReplies(context.db, now), now, ports.answer, (reply, answer) =>
      sendReply(context, reply, answer, ports, delivered),
    )
  })
