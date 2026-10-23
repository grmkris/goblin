import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chats } from '../chats/service.ts'
import { type AppError, Forbidden } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { type Boundary, boundaryOf, withinBoundary } from '../topics/boundary.ts'
import { type CallApi, turnPower } from './asker.ts'
import type { PiContext } from './context.ts'

// What the agent's own tools may act on from where they run (ADR 0115). A tool acts on its own chat's Topic from
// anywhere, and on another Topic only from a hub: renaming, archiving or setting it up, proposing or pausing its
// routines. Making Topics and Personas is not acting on another Topic; Sources, which route anywhere, need a hub
// whatever they name (`pi/tool-needs.ts`).

/** The boundary of the chat Pi session `session` belongs to; none for a session no chat owns, which reaches nothing. */
export const sessionBoundary = (session: string): Effect.Effect<Boundary | undefined, AppError, Chats | Db> =>
  Effect.gen(function* () {
    const chat = Option.getOrUndefined(yield* Chats.use((chats) => chats.chatOf(session)))
    if (chat === undefined) return undefined
    return yield* Db.useSync((db) => boundaryOf(db, chat))
  })

/**
 * Where the call `api` serves may reach: its chat's boundary, and a hub's only when its turn's power reaches every
 * Topic (no credential whose Topics are a list sent any of its inputs, `grants/power.ts`).
 */
export const callBoundary = (api: CallApi, context: PiContext) =>
  Effect.gen(function* () {
    const place = yield* sessionBoundary(String(api.conversationId))
    if (place === undefined) return undefined
    const power = yield* turnPower(api, context)
    return { topic: place.topic, hub: place.hub && power.topicLists.length === 0 } satisfies Boundary
  })

/** The call `api` serves acting on Topic `topic`: its own Topic, or any from a hub; else `Forbidden` `boundary`. */
export const requireWithin = (api: CallApi, context: PiContext, topic: number) =>
  Effect.gen(function* () {
    const boundary = yield* callBoundary(api, context)
    if (boundary === undefined || !withinBoundary(boundary, topic)) return yield* new Forbidden({ reason: 'boundary' })
    return boundary
  })
