import * as Effect from 'effect/Effect'
import { Setups } from '../setup/service.ts'
import { Topics } from './service.ts'

/** Current channel guidance for every scoped session, including forks, helpers and routine runs. */
export const topicContext = (session: string) =>
  Effect.gen(function* () {
    const scope = yield* Setups.use((setups) => setups.scope(session))
    const id = scope.topic?.id
    if (id === undefined) return undefined
    const topic = yield* Topics.use((topics) => topics.get(id))
    if (topic.description === undefined && topic.instructions === undefined) return undefined
    const text = [
      `Channel: #${topic.name}.`,
      'The owner configured this channel guidance. It applies to work here and grants no tools, connections, or permissions. Existing authority checks and Ask first still apply.',
      topic.description === undefined ? '' : `Purpose:\n${topic.description}`,
      topic.instructions === undefined ? '' : `Instructions:\n${topic.instructions}`,
    ]
      .filter((line) => line !== '')
      .join('\n\n')
    return text.replaceAll('</', '<\u200B/')
  })
