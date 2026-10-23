import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from './clock.ts'
import { Chats } from './chats/service.ts'
import { type AppError, attempt, attemptSync } from './http/errors.ts'
import { Models } from './models.ts'
import { BACKGROUND } from './pi/context.ts'
import { modelRef } from './pi/model.ts'
import { PiSessions, fromPi } from './pi/sessions.ts'
import type { TurnPower } from './grants/power.ts'
import type { Db } from './runtime/db.ts'
import { AgentInput } from './runtime/input.ts'
import { type ToolSets, filterFollowsScope, piToolsFor } from './setup/scope.ts'

export type Applied = Map<string, string>

/**
 * The Pi tool filter `useTools` applied to each session in this object's lifetime, by the names it removes; a change
 * of the filter outside it (a setup's, a helper's switches) forgets the session, so its next turn applies its own.
 */
export type Retooled = Map<string, string>

/** What `useTools` reads: Pi, the agent's database, the tool sets a filter removes, and what it applied already. */
export type Retooling = {
  readonly pi: PiSessions['Service']
  readonly db: Db['Service']
  readonly toolSets: ToolSets
  readonly retooled: Retooled
}

/**
 * Puts a session on the user's model before a turn. Pi stores one model per conversation, set when it is created, so
 * a pick (or a new deployment default) reaches existing conversations only this way. A server's work (`server`,
 * `serverWorkIn`) goes on `Models.forServers`, never on the owner's own subscriptions (ADR 0087). Skipped when
 * `applied` says the session is on it already.
 */
export const useModel = (pi: PiSessions['Service'], applied: Applied, session: string, server: boolean) =>
  Effect.gen(function* () {
    const models = yield* Models
    const id = yield* server ? models.forServers : models.current
    if (applied.get(session) === id) return
    yield* fromPi(pi.setModel(session, modelRef(id)))
    applied.set(session, id)
  })

/** A filter as `Retooled` remembers it: the names it removes, in order. */
const digestOf = (tools: ReturnType<typeof piToolsFor>): string =>
  tools === null ? '' : tools.remove.map((tool) => tool.name).join('\n')

/**
 * Offers `session` the tools a turn with `power` may use in chat `chat` (ADR 0115) before its sender's input reaches
 * it: Pi's filter is set again when what it removes changed since this object last set it (another sender's turn, a
 * filter stored before a deploy, one a failed retool left as it was). Only a chat whose filter follows its scope (not a
 * Persona's fork or a routine's run, whose filters are set when they are made). The power guard (`pi/power.ts`) refuses
 * whatever a filter still offers, so a run that takes several senders' inputs does no more than all of them may.
 */
export const useTools = (
  { pi, db, toolSets, retooled }: Retooling,
  chat: string,
  session: string,
  power: TurnPower,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const tools = yield* attemptSync(() =>
      filterFollowsScope(db, chat) ? piToolsFor(db, toolSets, chat, power) : undefined,
    )
    if (tools === undefined) return
    const digest = digestOf(tools)
    if (retooled.get(session) === digest) return
    const conversation = yield* fromPi(pi.conversation(session))
    if (Option.isSome(conversation)) yield* attempt(() => conversation.value.configure({ tools }, BACKGROUND))
    retooled.set(session, digest)
  })

/** The owner picks a model: main is put on it at once, the others at their next turn. */
export const chooseOwnerModel = (modelId: string) =>
  Effect.gen(function* () {
    const choice = yield* (yield* Models).choose(modelId, yield* epochSeconds)
    const chats = yield* Chats
    const { applied } = yield* AgentInput
    // The owner chose it in their own session, and main is in Personal, which no key made.
    yield* useModel(yield* PiSessions, applied, yield* chats.session(chats.primary), false)
    return choice
  })
