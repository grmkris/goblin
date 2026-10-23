import { type ConversationId, LiveDoc, type LiveState, type SubmissionId } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { receiptPowers } from '../chats/receipts.ts'
import { GRANT_SPEC, levelAtLeast } from '@goblin/contracts'
import { type ToolNeed, type TurnPower, powerOfAll } from '../grants/power.ts'
import { Forbidden, attempt, attemptSync } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { describeError } from '../telemetry/attributes.ts'
import type { PiContext } from './context.ts'
import { PiSessions, fromPi } from './sessions.ts'

/** What a tool call's or a hook's API is read through here: its conversation, and that conversation's live run. */
export type CallApi = {
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
 * What a run whose inputs are `inputs` (its input submissions) may do (ADR 0115): the power each input's receipt
 * recorded at admission, intersected. An input no receipt holds is a Source's, a routine's, the system's or the
 * agent's own, and counts as an admin's: only a request's receipt narrows a run. A Persona's turn is its asker's, a
 * subagent's message its spawner's (its relay records the spawner's power, `pi/subagent-relay.ts`).
 *
 * @internal Exported for its unit test, which reads it over each mix of a run's inputs.
 */
export const powerAmong = (inputs: readonly SubmissionId[], context: PiContext) =>
  Effect.gen(function* () {
    if (inputs.length === 0) return powerOfAll([])
    const pi = yield* PiSessions.use((sessions) => fromPi(sessions.pi))
    const requests = yield* attempt(async () => {
      const records = await Promise.all(inputs.map(async (id) => (await pi.submission(id, context))?.status(context)))
      // The request id as admitted and the operation it names: a client may choose an id shaped like a Persona turn's,
      // and its own receipt narrows it too.
      return records.flatMap((record) =>
        record?.requestId === undefined ? [] : [...new Set([record.requestId, inputOperation(record.requestId)])],
      )
    })
    const db = yield* Db
    return powerOfAll(yield* attemptSync(() => receiptPowers(db, requests)))
  })

/**
 * What the run `api`'s call or hook serves may do (ADR 0115): its inputs' power, the first message's and every message
 * steered into it since, so a run that batched an owner's and a server key's input does only what both may. A call
 * outside a live run is the agent's own work, an admin's.
 */
export const turnPower = (api: CallApi, context: PiContext) =>
  Effect.gen(function* () {
    const live = yield* attempt(() => api.snapshot(LiveDoc, api.conversationId, context))
    return yield* powerAmong(live?.run?.inputs ?? [], context)
  })

/** Whether `power` holds the level and extra `need` names. */
export const holds = (power: Pick<TurnPower, 'level' | 'extras'>, need: Partial<ToolNeed>): boolean =>
  (need.level === undefined || levelAtLeast(GRANT_SPEC, power.level, need.level)) &&
  (need.extra === undefined || power.extras.includes(need.extra))

/**
 * What a call asks for beyond its tool's own need (a setup it brings takes `setup`), checked against the run's power:
 * `Forbidden` `power` when one of its senders may not, whether a member by their role or a credential by its grant.
 */
export const requirePower = (api: CallApi, context: PiContext, need: Partial<ToolNeed>) =>
  Effect.flatMap(turnPower(api, context), (power) =>
    holds(power, need) ? Effect.void : Effect.fail(new Forbidden({ reason: 'power' })),
  )

/** What the model reads of a refusal for acting past its chat's sealed Topic (ADR 0115), and where it can be made. */
export const BOUNDARY_TEXT =
  "This chat's Topic is sealed: its tools act only on itself, so nothing changed. Changing another Topic, or the whole workspace, is done from a hub (Personal, unless an admin made another): tell whoever asked."

/** What the model reads when a turn's power does not reach a tool or what a call asks of it (ADR 0115). */
export const POWER_TEXT =
  'Whoever sent this turn may not do this: it takes an admin of this workspace, or a credential granted it, so nothing changed. Tell them that an admin has to make this change or widen their access.'

/**
 * What the model reads of a failure of a tool that changes `what`: refused for its turn's power (a member's role, a
 * credential's grant), who may make the change and what to tell them, in words it can relay; refused past its chat's
 * sealed Topic (ADR 0115), where it can be made; any other failure as `otherwise` reads it.
 */
export const adminOnly =
  (what: string, otherwise: (cause: unknown) => string = describeError) =>
  (cause: unknown): string =>
    cause instanceof Forbidden && cause.reason === 'power'
      ? `Changing ${what}: ${POWER_TEXT}`
      : cause instanceof Forbidden && cause.reason === 'boundary'
        ? BOUNDARY_TEXT
        : otherwise(cause)
