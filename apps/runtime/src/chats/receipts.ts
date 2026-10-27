import { WorkspaceRole } from '@goblin/contracts'
import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { type TurnPower, intersect, receiptPower, storedPower } from '../grants/power.ts'
import { Internal } from '../http/errors.ts'
import { appChatOperations } from '../storage/chat-operations.ts'

type Database<RunResult> = SQLiteAsyncDatabase<'sync', RunResult>
type Row = typeof appChatOperations.$inferSelect

/** How long a receipt is kept, in seconds: an operation replayed later than this is a new one. */
export const RECEIPT_RETENTION = 30 * 24 * 60 * 60

/** The operations a chat records (ADR 0030), besides passive writes. */
export const OPERATION_KINDS = [
  'send',
  'ask_client',
  'source',
  'persona_ask',
  'persona_reply',
  'start',
  'reply',
  'empty',
  'move',
  'share',
  'close',
  'stop',
  'routine_input',
  'subagent_report',
  'relay',
  'mcp_outcome',
] as const

/** What an operation in a chat is: one of `OPERATION_KINDS`, or `write:<entry kind>` for a passive write. */
export type OperationKind = (typeof OPERATION_KINDS)[number] | `write:${string}`
/** Who started an operation: `app` is an installed app (ADRs 0115, 0125), whose message is never the owner's. */
export const ReceiptOrigin = Schema.Literals(['owner', 'app', 'client', 'source', 'agent', 'routine', 'system'])
export type ReceiptOrigin = typeof ReceiptOrigin.Type

/**
 * How far an operation got: `admitted` before Pi saw it, then `submitted` (an input Pi took), `written` (a passive
 * write Pi took), `refused` (turned away, with a reason) or `settled` (done, with nothing more to follow).
 */
export const ReceiptState = Schema.Literals(['admitted', 'submitted', 'written', 'refused', 'settled'])
export type ReceiptState = typeof ReceiptState.Type

/** What an admission says about its operation: its kind, who started it, and what it came from or led to. */
export type ReceiptInput = {
  readonly kind: OperationKind
  readonly origin: ReceiptOrigin
  /**
   * The role of the member whose request admitted it (ADR 0099), which tells a member's turn from an admin's; none for
   * work no member sent: a Source's, a routine's, an installed app's, the system's.
   */
  readonly role?: WorkspaceRole
  /**
   * What its sender may do in a turn it starts or joins (ADR 0115, `grants/power.ts`); none for work no person or
   * credential sent, which is an admin's.
   */
  readonly power?: TurnPower
  /** The operation this one was made by (a thread's first message by its start, a write by its turn). */
  readonly parentOp?: string
  /** The chat the operation made or reached, when that is another one (a started thread, a move's Thread). */
  readonly targetChat?: string
}

/** An operation's receipt in one chat, as the runtime reads it. It carries ids and codes, never content. */
export type Receipt = {
  readonly chat: string
  readonly operationId: string
  readonly session: string
  readonly admittedAt: number
  readonly kind: OperationKind
  readonly origin?: ReceiptOrigin
  readonly role?: WorkspaceRole
  /** As stored; none for a receipt that stored none (`receiptPower` reads it by its origin). */
  readonly power?: TurnPower
  readonly targetChat?: string
  readonly parentOp?: string
  readonly state: ReceiptState
  /** Why it was refused: an error tag or a refusal code, never error text. */
  readonly reason?: string
  readonly settledAt?: number
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(OPERATION_KINDS)
const isOperationKind = (value: string): value is OperationKind => value.startsWith('write:') || KNOWN_KINDS.has(value)
const isOrigin = Schema.is(ReceiptOrigin)
const isRole = Schema.is(WorkspaceRole)
const isState = Schema.is(ReceiptState)

/**
 * A stored receipt, as `admitReceipt` wrote it and `advanceReceipt` moved it on. A row without a kind or a state
 * of its own is not one of them: `Internal`.
 */
export const decodeReceipt = (row: Row): Receipt => {
  const { kind, state } = row
  if (kind === null || !isOperationKind(kind) || state === null || !isState(state))
    throw new Internal({ reason: 'receipt_unreadable' })
  return {
    chat: row.chatId,
    operationId: row.operationId,
    session: row.sessionId,
    admittedAt: row.admittedAt,
    kind,
    ...(row.origin !== null && isOrigin(row.origin) ? { origin: row.origin } : {}),
    ...(row.role !== null && isRole(row.role) ? { role: row.role } : {}),
    ...(row.power === null ? {} : { power: receiptPower({ power: row.power }) }),
    ...(row.targetChat === null ? {} : { targetChat: row.targetChat }),
    ...(row.parentOp === null ? {} : { parentOp: row.parentOp }),
    state,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
  }
}

/** The receipt `operationId` has in `chat`, if it was admitted there. */
export function receiptIn<RunResult>(db: Database<RunResult>, chat: string, operationId: string): Receipt | undefined {
  const row = db
    .select()
    .from(appChatOperations)
    .where(and(eq(appChatOperations.chatId, chat), eq(appChatOperations.operationId, operationId)))
    .get()
  return row === undefined ? undefined : decodeReceipt(row)
}

/**
 * The first receipt of `operationId` in any chat, synchronously: what Pi's commit listener reads to tell where a
 * submission came from (its request id is the operation id).
 */
export function receiptOf<RunResult>(db: Database<RunResult>, operationId: string): Receipt | undefined {
  const row = db
    .select()
    .from(appChatOperations)
    .where(eq(appChatOperations.operationId, operationId))
    .orderBy(asc(appChatOperations.admittedAt))
    .limit(1)
    .get()
  return row === undefined ? undefined : decodeReceipt(row)
}

/** Every receipt `parentOp` led to, oldest first. */
export function relatedReceipts<RunResult>(db: Database<RunResult>, parentOp: string): readonly Receipt[] {
  return db
    .select()
    .from(appChatOperations)
    .where(eq(appChatOperations.parentOp, parentOp))
    .orderBy(asc(appChatOperations.admittedAt))
    .all()
    .map(decodeReceipt)
}

/** One admission: the chat, the operation, what it is, and the session it goes to when it is new. */
export type Admission = {
  readonly chat: string
  readonly operationId: string
  readonly receipt: ReceiptInput
  readonly session: () => string
  readonly now: number
}

/**
 * The powers of `operationIds` (ADR 0115): each receipt's, in any chat, that one of them has. An operation no receipt
 * holds is not among them.
 */
export function receiptPowers<RunResult>(
  db: Database<RunResult>,
  operationIds: readonly string[],
): readonly TurnPower[] {
  if (operationIds.length === 0) return []
  return db
    .select({ power: appChatOperations.power, origin: appChatOperations.origin, role: appChatOperations.role })
    .from(appChatOperations)
    .where(inArray(appChatOperations.operationId, [...operationIds]))
    .all()
    .map((row) => receiptPower({ ...row, role: row.role !== null && isRole(row.role) ? row.role : null }))
}

/**
 * What a replay of an operation changes of its receipt: a member's marks its role, and one with a power narrows the
 * receipt's to what both may do.
 */
function replayed<RunResult>(
  db: Database<RunResult>,
  at: { readonly chat: string; readonly operationId: string },
  previous: Receipt,
  receipt: ReceiptInput,
): void {
  const where = and(eq(appChatOperations.chatId, at.chat), eq(appChatOperations.operationId, at.operationId))
  if (receipt.role === 'member' && previous.role !== 'member')
    db.update(appChatOperations).set({ role: 'member' }).where(where).run()
  if (receipt.power === undefined) return
  const power = previous.power === undefined ? receipt.power : intersect(previous.power, receipt.power)
  db.update(appChatOperations)
    .set({ power: storedPower(power) })
    .where(where)
    .run()
}

/**
 * Records an operation's intent in its chat before Pi sees it, in one transaction, dropping every receipt past the
 * retention but this one. A replay finds its first receipt, so it keeps its first session; a replay by someone who may
 * do less narrows its power, and a member's marks its role, so reusing an operation id never hides who asked (ADRs
 * 0099, 0115).
 */
export function admitReceipt<RunResult>(
  db: Database<RunResult>,
  admission: Admission,
): { readonly session: string; readonly existing: boolean } {
  const { chat, operationId, receipt, now } = admission
  return db.transaction(() => {
    db.delete(appChatOperations)
      .where(
        and(lt(appChatOperations.admittedAt, now - RECEIPT_RETENTION), ne(appChatOperations.operationId, operationId)),
      )
      .run()
    const previous = receiptIn(db, chat, operationId)
    if (previous !== undefined) {
      replayed(db, { chat, operationId }, previous, receipt)
      return { session: previous.session, existing: true }
    }
    const session = admission.session()
    db.insert(appChatOperations)
      .values({
        chatId: chat,
        operationId,
        sessionId: session,
        admittedAt: now,
        kind: receipt.kind,
        origin: receipt.origin,
        role: receipt.role ?? null,
        power: receipt.power === undefined ? null : storedPower(receipt.power),
        targetChat: receipt.targetChat ?? null,
        parentOp: receipt.parentOp ?? null,
        state: 'admitted',
      })
      .run()
    return { session, existing: false }
  })
}

/** How an operation went on: its new state, with a reason when refused; refused and settled stamp when. */
export type ReceiptChange = {
  readonly state: Exclude<ReceiptState, 'admitted'>
  readonly reason?: string
  readonly targetChat?: string
  readonly now: number
}

/** Moves `operationId`'s receipt in `chat` on to `change.state`; a receipt that is gone stays gone. */
export function advanceReceipt<RunResult>(
  db: Database<RunResult>,
  chat: string,
  operationId: string,
  change: ReceiptChange,
): void {
  const ends = change.state === 'refused' || change.state === 'settled'
  db.update(appChatOperations)
    .set({
      state: change.state,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.targetChat === undefined ? {} : { targetChat: change.targetChat }),
      ...(ends ? { settledAt: change.now } : {}),
    })
    .where(and(eq(appChatOperations.chatId, chat), eq(appChatOperations.operationId, operationId)))
    .run()
}
