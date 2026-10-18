import {
  PERSONAL_TOPIC,
  SourceSetup,
  type AskedSource,
  type AskedSourceRoute,
  type SourceNewKeys,
  type SourceRoute,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import { personaNamed } from '../personas/program.ts'
import { topicNamed } from '../topics/program.ts'

const topicId = (name: string) =>
  name.trim().toLowerCase() === 'personal'
    ? Effect.succeed(PERSONAL_TOPIC)
    : Effect.map(topicNamed(name), (topic) => topic.id)

/** Resolve the same named route for individual Sources, composition and route edits. */
export const routeOfAsked = (asked: AskedSourceRoute) =>
  Effect.gen(function* () {
    if (asked.to === 'ignore' || asked.to === 'held') return { to: asked.to } satisfies SourceRoute
    if (asked.to === 'persona') {
      const persona = (yield* personaNamed(asked.persona)).id
      return { to: 'persona', persona, topic: yield* topicId(asked.topic ?? 'Personal') } satisfies SourceRoute
    }
    return { to: asked.to, topic: yield* topicId(asked.topic) } satisfies SourceRoute
  })

/** Resolve names and validate the complete setup before any draft is written. */
export const resolveAskedSource = (asked: AskedSource) =>
  Effect.gen(function* () {
    const { connectionId, title, newKeys, ...facts } = asked
    const route: SourceNewKeys =
      newKeys?.to === 'topic-per-key' ? newKeys : yield* routeOfAsked(newKeys ?? { to: 'held' })
    const setup = yield* Schema.decodeUnknownEffect(SourceSetup)({ ...facts, newKeys: route }).pipe(
      Effect.mapError((issue) => new InvalidInput({ reason: issue.message })),
    )
    return { connectionId, title, setup }
  })
