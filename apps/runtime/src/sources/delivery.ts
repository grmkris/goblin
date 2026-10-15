// Answers owed to Source conversations: each waits for its turn to end, a day at most, then goes out.
// The run ledger records each message in and each answer out.
import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { chatSession, operationSession, primaryChat } from '../chats/directory.ts'
import type { RunTelemetry } from '../telemetry/events.ts'

/** How long a turn's answer is waited for before it is given up, in seconds. */
export const REPLY_WINDOW = 86_400

/** What a ledger of messages in and answers out writes to: the agent's database and its run ledger. */
export type LedgerInput = {
  readonly db: DrizzleSqliteDODatabase
  readonly telemetry: RunTelemetry | undefined
}

/**
 * One message in, one answer out, in the run ledger (ADR 0024), by the turn's operation id and the chat it ran in,
 * attributed to the Source path. Ids and counts only, never content.
 */
export const turnLedger =
  ({ db, telemetry }: LedgerInput) =>
  (
    kind: 'source.received' | 'source.reply',
    turn: { readonly operationId: string; readonly chatId: string | undefined },
    startedAt: number,
    extra: RunAttributes,
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
      Effect.sync(() => {
        const chat = turn.chatId ?? primaryChat
        telemetry?.record({
          id: `${kind === 'source.received' ? 'source' : 'reply'}:${turn.operationId}`,
          kind,
          status: RunAttribute.errorType in extra ? 'error' : 'ok',
          conversationId: operationSession(db, chat, turn.operationId) ?? chatSession(db, chat),
          operationId: turn.operationId,
          startedAt,
          endedAt,
          attributes: { [RunAttribute.source]: 'source', ...extra },
        })
      }),
    )
