import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chats } from '../chats/service.ts'
import { type AppError, Forbidden } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { type Boundary, boundaryOf, withinBoundary } from '../topics/boundary.ts'

// What the agent's own tools may act on from where they run (ADR 0115). A tool acts on its own chat's Topic from
// anywhere, and on another Topic only from a hub: renaming, archiving or setting it up, routing a Source into it,
// proposing or pausing its routines. Making Topics and Personas is not acting on another Topic.

/** The boundary of the chat Pi session `session` belongs to; none for a session no chat owns, which reaches nothing. */
export const sessionBoundary = (session: string): Effect.Effect<Boundary | undefined, AppError, Chats | Db> =>
  Effect.gen(function* () {
    const chat = Option.getOrUndefined(yield* Chats.use((chats) => chats.chatOf(session)))
    if (chat === undefined) return undefined
    return yield* Db.useSync((db) => boundaryOf(db, chat))
  })

/** Work in `session` acting on Topic `topic`: its own Topic, or any from a hub; else `Forbidden` `boundary`. */
export const requireWithin = (session: string, topic: number) =>
  Effect.gen(function* () {
    const boundary = yield* sessionBoundary(session)
    if (boundary === undefined || !withinBoundary(boundary, topic)) return yield* new Forbidden({ reason: 'boundary' })
    return boundary
  })

/** Work in `session` acting on the whole workspace, as a Source's routes are: only from a hub. */
export const requireHub = (session: string) =>
  Effect.gen(function* () {
    const boundary = yield* sessionBoundary(session)
    if (boundary?.hub !== true) return yield* new Forbidden({ reason: 'boundary' })
    return boundary
  })

/** What the model reads of a refusal for acting past its chat's Topic: why, and where the change can be made. */
export const BOUNDARY_TEXT =
  "This chat's Topic is sealed: its tools act only on itself, so nothing changed. Changing another Topic, or the whole workspace, is done from a hub (Personal, unless an admin made another): tell whoever asked."
