// Answers owed to the places the owner's messages came from, shared by the Telegram channel and Sources: each waits for
// its turn to end, a day at most, then goes out; and the run ledger's line for each message in and each answer out.
import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { chatSession, operationSession, primaryChat } from '../chats/directory.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import type { Answer, ReplyRef } from './turns.ts'

/** How long a turn's answer is waited for before it is given up, in seconds. */
const REPLY_WINDOW = 86_400

/** An answer owed: the turn it belongs to, and when its message came in (epoch seconds). */
type Owed = ReplyRef & { readonly createdAt: number }

/**
 * Sends every answer of `owed` that is ready, in order: `answer` reads how its turn ended, and `send` sends it, or gives
 * it up (with no answer) once its turn ran a day without one. True while some are still running.
 */
export const deliverReady = <O extends Owed, E, R>(
  owed: readonly O[],
  now: number,
  answer: (reply: O) => Effect.Effect<Answer | undefined, E, R>,
  send: (reply: O, answer: Answer | undefined) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    let waiting = false
    for (const reply of owed) {
      const answered = yield* answer(reply)
      if (answered === undefined && now - reply.createdAt < REPLY_WINDOW) waiting = true
      else yield* send(reply, answered)
    }
    return waiting
  })

/** What a ledger of messages in and answers out writes to: the agent's database and its run ledger. */
export type LedgerInput = {
  readonly db: DrizzleSqliteDODatabase
  readonly telemetry: RunTelemetry | undefined
}

/**
 * One message in, one answer out, in the run ledger (ADR 0024), by the turn's operation id and the chat it ran in,
 * attributed to `channel` (`telegram`, `source`). Ids and counts only, never content.
 */
export const turnLedger =
  ({ db, telemetry }: LedgerInput, channel: string) =>
  (
    kind: 'channel.received' | 'channel.reply',
    turn: { readonly operationId: string; readonly chatId: string | undefined },
    startedAt: number,
    extra: RunAttributes,
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
      Effect.sync(() => {
        const chat = turn.chatId ?? primaryChat
        telemetry?.record({
          id: `${kind === 'channel.received' ? 'channel' : 'reply'}:${turn.operationId}`,
          kind,
          status: RunAttribute.errorType in extra ? 'error' : 'ok',
          conversationId: operationSession(db, chat, turn.operationId) ?? chatSession(db, chat),
          operationId: turn.operationId,
          startedAt,
          endedAt,
          attributes: { [RunAttribute.channel]: channel, ...extra },
        })
      }),
    )
