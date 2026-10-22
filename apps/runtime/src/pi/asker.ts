import { type ConversationId, LiveDoc, type LiveState, type SubmissionId } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { askedByMember } from '../chats/receipts.ts'
import { Forbidden, attempt, attemptSync } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { describeError } from '../telemetry/attributes.ts'
import type { PiContext } from './context.ts'
import { PiSessions, fromPi } from './sessions.ts'

/** What a tool call's execution API is read through here: its conversation, and that conversation's live run. */
type CallApi = {
  readonly conversationId: ConversationId
  readonly snapshot: (
    token: typeof LiveDoc,
    conversation: ConversationId,
    context: PiContext,
  ) => Promise<Readonly<LiveState> | undefined>
}

/** A Persona's turn names the operation that tagged it, or the reply that resumed it (`pi/persona-turn.ts`). */
const PERSONA_TURN = /^persona(?:-resume)?:(.+):\d+$/u

/**
 * The operation a run's input came from: its request id, which is the operation id of everything a chat admits, or for
 * a Persona's turn (`persona:<operation>:<persona>`) the operation that asked it.
 *
 * @internal Exported for its unit test, which pins the Persona turn's request ids.
 */
export const inputOperation = (requestId: string): string => PERSONA_TURN.exec(requestId)?.[1] ?? requestId

/**
 * Whether a member below admin asked for any of `inputs`, a run's input submissions (ADR 0099): one of their operations
 * was admitted from such a member's request. An input no receipt holds, or whose receipt names no member, is a
 * Source's, a routine's, the system's or the agent's own, and counts as an admin's: only a member's request marks one.
 *
 * @internal Exported for its unit test, which reads it over each mix of a run's inputs.
 */
export const memberAmong = (inputs: readonly SubmissionId[], context: PiContext) =>
  Effect.gen(function* () {
    if (inputs.length === 0) return false
    const pi = yield* PiSessions.use((sessions) => fromPi(sessions.pi))
    const requests = yield* attempt(async () => {
      const records = await Promise.all(inputs.map(async (id) => (await pi.submission(id, context))?.status(context)))
      return records.flatMap((record) => (record?.requestId === undefined ? [] : [inputOperation(record.requestId)]))
    })
    const db = yield* Db
    return yield* attemptSync(() => askedByMember(db, requests))
  })

/**
 * Whether the run `api`'s call serves took a member's input (ADR 0099): its first message, or a message steered into
 * it since, so a run that batched an owner's and a member's input is a member's. None while no run is live.
 */
const memberTurn = (api: CallApi, context: PiContext) =>
  Effect.gen(function* () {
    const live = yield* attempt(() => api.snapshot(LiveDoc, api.conversationId, context))
    return yield* memberAmong(live?.run?.inputs ?? [], context)
  })

/**
 * A change to what the agent works with (ADR 0098) asked for on a member's turn: `Forbidden` `role`, as owner admission
 * refuses the member's own request for it (`requireAdminFor`). Anyone else's turn passes.
 */
export const requireAdminTurn = (api: CallApi, context: PiContext) =>
  Effect.flatMap(memberTurn(api, context), (member) =>
    member ? Effect.fail(new Forbidden({ reason: 'role' })) : Effect.void,
  )

/**
 * What the model reads of a failure of a tool that changes `what`: refused on a member's turn, who may make the change
 * and what to tell the member, in words it can relay; any other failure as `otherwise` reads it.
 */
export const adminOnly =
  (what: string, otherwise: (cause: unknown) => string = describeError) =>
  (cause: unknown): string =>
    cause instanceof Forbidden && cause.reason === 'role'
      ? `Changing ${what} takes an admin of this workspace, and a member asked for it in this turn, so nothing changed. Tell them that an admin has to make this change and that they can ask one.`
      : otherwise(cause)
