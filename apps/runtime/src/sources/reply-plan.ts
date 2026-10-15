// Frozen Source reply calls and durable piece progress (ADR 0072). No transaction spans a tool call.
import { SinkResultRules, fillTemplate, type SourceReply } from '@goblin/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appSourceReplies } from '../storage/sources.ts'
import { asArguments } from './messages.ts'
import { type ReplyRow, type SourceRow, routeRow, valuesOf } from './store.ts'
import { chunks, operationIdOf } from './text.ts'

const ReplyPlan = Schema.Struct({
  connectionId: Schema.String,
  setup: Schema.String,
  tool: Schema.String,
  result: Schema.optionalKey(SinkResultRules),
  calls: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
})
export type ReplyPlan = typeof ReplyPlan.Type
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ReplyPlan))
type Db = DrizzleSqliteDODatabase

/** The already frozen calls; no transcript is needed once this plan exists. */
export const savedReplyPlan = (reply: ReplyRow): ReplyPlan | undefined =>
  reply.plan === null ? undefined : Option.getOrUndefined(decode(reply.plan))

/** Freeze text, chunk boundaries, template, keys and result rules before the first dispatch. */
export function planReply(
  db: Db,
  reply: ReplyRow,
  source: SourceRow,
  setup: SourceReply,
  text: string,
): ReplyPlan | undefined {
  if (reply.plan !== null) return savedReplyPlan(reply)
  const values = valuesOf(routeRow(db, source.id, reply.key) ?? { keyValues: '{}' })
  const plan = {
    connectionId: source.connectionId,
    setup: source.setup,
    tool: setup.tool,
    ...(setup.result === undefined ? {} : { result: setup.result }),
    calls: chunks(text, setup.maxChars).map((piece, index) =>
      asArguments(
        fillTemplate(setup.arguments, {
          text: piece,
          operationId: operationIdOf(`reply-${String(index)}`, reply.operationId),
          ...Object.fromEntries(Object.entries(values).map(([name, value]) => [`key.${name}`, value])),
        }),
      ),
    ),
  }
  const encoded = JSON.stringify(plan)
  db.update(appSourceReplies)
    .set({ plan: encoded })
    .where(and(eq(appSourceReplies.operationId, reply.operationId), isNull(appSourceReplies.plan)))
    .run()
  return Option.getOrUndefined(decode(encoded))
}

/** Intent survives process loss. A retained intent without a result is terminal unknown, never replayed. */
export function dispatchPiece(db: Db, operationId: string, index: number): boolean {
  return (
    db
      .update(appSourceReplies)
      .set({ dispatching: true })
      .where(
        and(
          eq(appSourceReplies.operationId, operationId),
          isNull(appSourceReplies.outcome),
          eq(appSourceReplies.nextPiece, index),
          eq(appSourceReplies.dispatching, false),
        ),
      )
      .returning({ id: appSourceReplies.operationId })
      .all().length === 1
  )
}

/** An explicitly accepted piece is committed before the next one can leave. */
export function acceptPiece(db: Db, operationId: string, index: number): void {
  db.update(appSourceReplies)
    .set({ nextPiece: index + 1, dispatching: false })
    .where(
      and(
        eq(appSourceReplies.operationId, operationId),
        isNull(appSourceReplies.outcome),
        eq(appSourceReplies.nextPiece, index),
        eq(appSourceReplies.dispatching, true),
      ),
    )
    .run()
}
