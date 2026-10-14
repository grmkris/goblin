// Where a Telegram route's "New topic" goes (ADR 0055): a Topic named after the chat or forum topic, made once per chat
// and topic by a deterministic operation, or the active Topic of that name when there is one.
import * as Effect from 'effect/Effect'
import { createTopic, topicNamed } from '../topics/program.ts'

/** The deterministic operation of the Topic a chat's or topic's "New topic" makes. */
export const topicOperation = (chat: string, thread: number) => `telegram:${chat}:${String(thread)}`

/** A chat's title as a Topic's name: at most 80 characters, `Telegram` when it has none. */
const topicName = (title: string) => {
  const clean = title.trim().slice(0, 80).trim()
  return clean === '' ? 'Telegram' : clean
}

/**
 * The Topic a route's "New topic" makes, named after its chat or topic, as `actor` asked: the one this operation already
 * made, or an active Topic of that name. A Topic made for the same chat before and archived since is made again.
 */
export const topicFor = (title: string, operationId: string, actor: 'owner' | 'agent') =>
  Effect.gen(function* () {
    const name = topicName(title)
    const made = yield* createTopic({ name, operationId }, { actor }).pipe(
      Effect.catchTag('Conflict', () => topicNamed(name)),
    )
    if (made.archivedAt === undefined) return made.id
    const again = yield* createTopic({ name, operationId: `${operationId}:${String(made.revision)}` }, { actor }).pipe(
      Effect.catchTag('Conflict', () => topicNamed(name)),
    )
    return again.id
  })
