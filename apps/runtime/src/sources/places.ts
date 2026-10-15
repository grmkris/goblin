// The places a route sends the owner's messages to, shared by the Telegram channel and Sources: a Topic that is open
// and a Persona that is active, and each named in words for a receipt or the agent.
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound } from '../http/errors.ts'
import { Personas } from '../personas/service.ts'
import { Topics } from '../topics/service.ts'

/** `topic` while it is active; `NotFound` otherwise. */
export const activeTopic = (topic: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Topics).get(topic)
    if (found.archivedAt !== undefined) return yield* new NotFound({ what: 'topic' })
    return found.id
  })

/** `persona` while it is active; `NotFound` otherwise. */
export const activePersona = (persona: number) =>
  Effect.gen(function* () {
    const active = yield* (yield* Personas).active
    if (!active.some((each) => each.id === persona)) return yield* new NotFound({ what: 'persona' })
    return persona
  })

/** A Topic in words: `#<name>`, `#Personal` for one that is gone. */
export const topicWords = (topic: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Topics).get(topic).pipe(Effect.option)
    return `#${Option.match(found, { onNone: () => 'Personal', onSome: ({ name }) => name })}`
  })

/** A Persona in words: `@<name>`, `@Persona` for one that is gone. */
export const personaWords = (persona: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Personas).get(persona).pipe(Effect.option)
    return `@${Option.match(found, { onNone: () => 'Persona', onSome: ({ name }) => name })}`
  })
