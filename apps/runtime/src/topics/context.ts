import * as Effect from 'effect/Effect'
import type { ScopeTopic } from '../setup/scope.ts'
import { Setups } from '../setup/service.ts'

/** A channel's guidance as its model reads it, in the context tail; none when the owner wrote neither part. */
const guidanceText = ({ name, description, instructions }: ScopeTopic): string | undefined =>
  description === '' && instructions === ''
    ? undefined
    : [
        `Channel: #${name}.`,
        'The owner configured this channel guidance. It applies to work here and grants no tools, connections, or permissions. Existing authority checks and Ask first still apply.',
        description === '' ? '' : `Purpose:\n${description}`,
        instructions === '' ? '' : `Instructions:\n${instructions}`,
      ]
        .filter((line) => line !== '')
        .join('\n\n')

/** Current channel guidance for every scoped session, including forks, helpers and routine runs. */
export const topicContext = (session: string) =>
  Effect.map(
    Setups.use((setups) => setups.scope(session)),
    ({ topic }) => (topic === undefined ? undefined : guidanceText(topic)),
  )
