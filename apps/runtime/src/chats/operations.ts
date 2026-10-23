import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { PiReceipt } from 'agents/harness/pi'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { type Applied, type Retooling, useModel, useRoomTools } from '../agent-model.ts'
import { Budget } from '../budget.ts'
import { type AppError, attemptSync, toAppError } from '../http/errors.ts'
import { Models } from '../models.ts'
import { FlowEvents, failedFlow } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { safeErrorType } from '../observability/report.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { SessionId, chatSession, openChatSession, topicOfChat } from './directory.ts'
import { requestRole, serverWorkIn } from '../grants/policy.ts'
import { epochSeconds } from '../clock.ts'
import {
  type ReceiptChange,
  type ReceiptInput,
  admitReceipt,
  advanceReceipt,
  receiptIn,
  relatedReceipts,
} from './receipts.ts'
import { type Admission, type Admitted, ChatOperations, type PassiveWrite, type Submit } from './service.ts'

/** Each chat's admission lock: `KeyedLock`'s, first come first served. */
const chatLock =
  (locks: KeyedLock['Service']) =>
  <A, E, R>(chat: string, effect: Effect.Effect<A, E, R>) =>
    locks.withLock(`chat:${chat}`)(effect).pipe(Effect.withSpan('ChatOperations.withChat'))

/**
 * The receipts in the agent's SQLite (chats/receipts.ts), each read or write with the Clock's time. Every admission
 * records the role of the member whose request it came in (ADR 0099), here for all of them rather than at each caller:
 * the agent's tools read it to tell a member's turn, whatever admitted it. Each role is kept, not only a member's, so a
 * receipt tells an owner's or an admin's request from work no member sent.
 */
const receiptsOf = (db: Db['Service']) => ({
  record: Effect.fn('ChatOperations.record')(function* (chat: string, operationId: string, input: ReceiptInput) {
    const now = yield* epochSeconds
    const role = yield* requestRole
    const receipt = role === undefined ? input : { ...input, role }
    const admitted = yield* attemptSync(() =>
      admitReceipt(db, { chat, operationId, receipt, session: () => chatSession(db, chat), now }),
    )
    return { session: SessionId(admitted.session), existing: admitted.existing } satisfies Admitted
  }),
  operation: Effect.fn('ChatOperations.operation')(function* (chat: string, operationId: string) {
    const found = Option.fromNullishOr(yield* attemptSync(() => receiptIn(db, chat, operationId)))
    return Option.map(found, (receipt) => SessionId(receipt.session))
  }),
  receipt: Effect.fn('ChatOperations.receipt')(function* (chat: string, operationId: string) {
    return Option.fromNullishOr(yield* attemptSync(() => receiptIn(db, chat, operationId)))
  }),
  related: Effect.fn('ChatOperations.related')(function* (operationId: string) {
    return yield* attemptSync(() => relatedReceipts(db, operationId))
  }),
  advance: Effect.fn('ChatOperations.advance')(function* (
    chat: string,
    operationId: string,
    change: Omit<ReceiptChange, 'now'>,
  ) {
    const now = yield* epochSeconds
    yield* attemptSync(() => advanceReceipt(db, chat, operationId, { ...change, now }))
  }),
})

type Receipts = ReturnType<typeof receiptsOf>
type Lock = ReturnType<typeof chatLock>

/** `ChatOperations.tracked`: the receipt recorded, `work`, then the receipt moved on, or refused if `work` failed. */
const trackedWith =
  (receipts: Receipts) =>
  <A, E, R>(
    chat: string,
    operationId: string,
    receipt: ReceiptInput,
    work: (admitted: Admitted) => Effect.Effect<A, E, R>,
    end: (value: A) => Omit<ReceiptChange, 'now'>,
  ): Effect.Effect<A, E | AppError, R> =>
    Effect.gen(function* () {
      const admitted = yield* receipts.record(chat, operationId, receipt)
      const value = yield* work(admitted).pipe(
        Effect.tapError((error) =>
          receipts.advance(chat, operationId, { state: 'refused', reason: safeErrorType(error) }),
        ),
      )
      yield* receipts.advance(chat, operationId, end(value))
      return value
    })

/** A passive write while `chat`'s lock is held: its receipt, Pi's write into the session it names, then `written`. */
const writeHeld = (receipts: Receipts, pi: PiSessions['Service']) =>
  Effect.fn('ChatOperations.passiveWrite')(function* (chat: string, write: PassiveWrite) {
    const { requestId, entry, origin = 'system', parentOp } = write
    const receipt = { kind: `write:${entry.kind}`, origin, ...(parentOp === undefined ? {} : { parentOp }) } as const
    const { session } = yield* receipts.record(chat, requestId, receipt)
    const submission = yield* pi
      .write(session, { requestId, entry })
      .pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
    yield* receipts.advance(chat, requestId, { state: 'written' })
    return submission
  })

/** Records `admission`'s one flow event once `run` ends: `ok`, `replayed`, or how it failed, with its time. */
const flowed = <A, E, R>(
  flows: FlowEvents['Service'],
  admission: Admission,
  run: Effect.Effect<{ readonly value: A; readonly existing: boolean }, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const exit = yield* Effect.exit(run)
    const ms = Math.max(0, (yield* Clock.currentTimeMillis) - started)
    const { chat, operationId, flow } = admission
    const status: Pick<FlowEvent, 'status' | 'errorType'> = Exit.isSuccess(exit)
      ? { status: exit.value.existing ? 'replayed' : 'ok' }
      : failedFlow(Cause.squash(exit.cause))
    yield* flows.record({ ...flow, chat, operationId, ...status, ms })
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return exit.value.value
  })

/** What the one admission sequence reads, captured once when the layer is built. */
type Admitting = {
  readonly withChat: Lock
  readonly tracked: ReturnType<typeof trackedWith>
  readonly flows: FlowEvents['Service']
  readonly requireOpen: (chat: string) => string
}

/** `ChatOperations.admit`: under the lock, the chat open, the receipt, `then`, the receipt's end; one flow event. */
const admitWith =
  ({ withChat, tracked, flows, requireOpen }: Admitting) =>
  <A, E, R>(admission: Admission, then: (admitted: Admitted) => Effect.Effect<A, E, R>) => {
    const { chat, operationId, receipt } = admission
    const admitted = Effect.andThen(
      attemptSync(() => requireOpen(chat)),
      tracked(
        chat,
        operationId,
        receipt,
        (found) => Effect.map(then(found), (value) => ({ value, existing: found.existing })),
        () => ({ state: 'submitted' }),
      ),
    )
    return flowed(flows, admission, withChat(chat, admitted)).pipe(Effect.withSpan('ChatOperations.admit'))
  }

/**
 * What an input's hand-on reads: the budget, Pi, the owner's model, whose work the chat's Topic holds, and the tool
 * filter its first turn in this lifetime applies (ADR 0108).
 */
type Sending = {
  readonly admit: ReturnType<typeof admitWith>
  readonly budget: Budget['Service']
  readonly models: Models['Service']
  readonly pi: PiSessions['Service']
  readonly applied: Applied
  readonly db: Db['Service']
  readonly retooling: Retooling
}

/** `ChatOperations.send`: the one admission sequence of an input (ADR 0030). */
const sendWith =
  ({ admit, budget, models, pi, applied, db, retooling }: Sending) =>
  <R = never>(input: Submit<R>): Effect.Effect<PiReceipt, AppError, R> =>
    Effect.gen(function* () {
      yield* budget.require(yield* epochSeconds)
      const { operationId, content, answer, relay } = input
      return yield* admit(input, ({ session }) =>
        Effect.gen(function* () {
          if (answer !== undefined && (yield* answer(session)))
            return { session, operationId, accepted: true } satisfies PiReceipt
          const server = yield* serverWorkIn(db, yield* attemptSync(() => topicOfChat(db, input.chat)))
          yield* useModel(pi, applied, session, server).pipe(Effect.provideService(Models, models))
          yield* useRoomTools(retooling, input.chat, session)
          if (relay !== undefined) return yield* relay(session)
          return yield* fromPi(pi.submit(session, content, { operationId }))
        }),
      )
    }).pipe(Effect.withSpan('ChatOperations.send'))

/**
 * The chat operations: receipts and the chat directory in the agent's SQLite, the chat's lock in `KeyedLock`, Pi
 * through `PiSessions`, flows through `FlowEvents`.
 */
export const makeChatOperations = Effect.gen(function* () {
  const db = yield* Db
  const pi = yield* PiSessions
  const flows = yield* FlowEvents
  const { applied, toolSets, retooled } = yield* AgentInput
  const withChat = chatLock(yield* KeyedLock)
  const receipts = receiptsOf(db)
  const written = writeHeld(receipts, pi)
  const tracked = trackedWith(receipts)
  const admit = admitWith({ withChat, tracked, flows, requireOpen: (chat) => openChatSession(db, chat) })
  const retooling = { pi, db, toolSets, retooled }
  const sending = { admit, budget: yield* Budget, models: yield* Models, pi, applied, db, retooling }
  return ChatOperations.of({
    ...receipts,
    tracked,
    withChat,
    passiveWrite: (chat, write) => withChat(chat, written(chat, write)),
    admit,
    send: sendWith(sending),
  })
})
