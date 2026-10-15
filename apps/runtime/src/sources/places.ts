// The places a route sends the owner's messages to, shared by the Telegram channel and Sources: a Topic that is open
// and a Persona that is active, and each named in words for a receipt or the agent.
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound } from '../http/errors.ts'
import { Personas } from '../personas/service.ts'
import { createTopic, topicNamed } from '../topics/program.ts'
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

/** A conversation's title as a Topic's name: at most 80 characters, `fallback` when it has none. */
const topicName = (title: string, fallback: string) => {
  const clean = title.trim().slice(0, 80).trim()
  return clean === '' ? fallback.slice(0, 80) : clean
}

/**
 * The Topic made for a conversation (a Telegram route's "New topic", a Source's new conversation), named after it, as
 * `actor` asked: the one this operation already made, or an active Topic of that name. A Topic made for the same
 * conversation before and archived since is made again.
 */
export const topicFor = (title: string, operationId: string, actor: 'owner' | 'agent', fallback: string) =>
  Effect.gen(function* () {
    const name = topicName(title, fallback)
    const made = yield* createTopic({ name, operationId }, { actor }).pipe(
      Effect.catchTag('Conflict', () => topicNamed(name)),
    )
    if (made.archivedAt === undefined) return made.id
    const again = yield* createTopic({ name, operationId: `${operationId}:${String(made.revision)}` }, { actor }).pipe(
      Effect.catchTag('Conflict', () => topicNamed(name)),
    )
    return again.id
  })

/** A Persona in words: `@<name>`, `@Persona` for one that is gone. */
export const personaWords = (persona: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Personas).get(persona).pipe(Effect.option)
    return `@${Option.match(found, { onNone: () => 'Persona', onSome: ({ name }) => name })}`
  })
