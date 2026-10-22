import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from './clock.ts'
import { Chats } from './chats/service.ts'
import { type AppError, attempt, attemptSync } from './http/errors.ts'
import { Models } from './models.ts'
import { BACKGROUND } from './pi/context.ts'
import { modelRef } from './pi/model.ts'
import { PiSessions, fromPi } from './pi/sessions.ts'
import type { Db } from './runtime/db.ts'
import { AgentInput } from './runtime/input.ts'
import { type ToolSets, filterFollowsScope, piToolsFor } from './setup/scope.ts'

export type Applied = Map<string, string>

/** The sessions whose Pi tool filter `useRoomTools` applied in this object's lifetime. */
export type Retooled = Set<string>

/** What `useRoomTools` reads: Pi, the agent's database, the tool sets a filter removes, and what it applied already. */
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

/**
 * Applies chat `chat`'s Pi tool filter to `session` before its first turn in this object's lifetime (ADR 0108): a
 * filter stored before a deploy changed what a room offers, or one a failed retool left as it was, is put right before
 * the model is asked again. Only a chat whose filter follows its scope (not a Persona's fork or a routine's run, whose
 * filters are set when they are made). The room guard (`pi/room.ts`) refuses whatever a stale filter still offers.
 */
export const useRoomTools = (
  { pi, db, toolSets, retooled }: Retooling,
  chat: string,
  session: string,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    if (retooled.has(session)) return
    const tools = yield* attemptSync(() =>
      filterFollowsScope(db, chat) ? { filter: piToolsFor(db, toolSets, chat) } : undefined,
    )
    if (tools !== undefined) {
      const conversation = yield* fromPi(pi.conversation(session))
      if (Option.isSome(conversation))
        yield* attempt(() => conversation.value.configure({ tools: tools.filter }, BACKGROUND))
    }
    retooled.add(session)
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
