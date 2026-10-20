import type { CreateTopic } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { KEY_TOPIC_SETUP, claim, confineSetup, confineSetupEdit, confineTopic, requestKey } from '../keys/policy.ts'
import { createTopic, editTopicSetup, madeTopic, updateTopic } from './program.ts'
import { Topics } from './service.ts'

/** How many Topics a page answers when the caller names no limit. */
const PAGE = 50

/** A page of Topics: every one for the owner, only its own for a server's API key (ADR 0084). */
const list = (query: { readonly cursor?: string | undefined; readonly limit?: number | undefined }) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    return yield* Topics.use((topics) =>
      topics.page({
        ...(key === undefined ? {} : { key: key.keyId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit ?? PAGE,
      }),
    )
  })

/**
 * A Topic a server's API key makes (ADR 0081): narrowed to nothing unless it names a setup under its ceiling, and its
 * own from then on. The owner's own create is unchanged.
 */
const create = (input: CreateTopic) =>
  Effect.gen(function* () {
    if ((yield* requestKey) === undefined) return yield* createTopic(input, { actor: 'owner' })
    const keyed = { ...input, setup: input.setup ?? KEY_TOPIC_SETUP }
    yield* confineSetup(keyed.setup)
    const made = yield* madeTopic(keyed, { actor: 'owner' })
    yield* claim('topic', made.topic.id, made.created)
    return made.topic
  })

/**
 * The `topics` group (ADR 0032), the reference the other groups copy: each handler runs its program. Owner admission
 * has already admitted the request; a program's `AppError` is answered in its envelope, and services come from the
 * agent's runtime. A request an API key sent reaches only the key's own Topics (ADR 0081).
 */
export const TopicsHandlers = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
  handlers
    .handle('list', ({ query }) => list(query))
    .handle('get', ({ params }) =>
      Effect.andThen(
        confineTopic(params.id),
        Topics.use((topics) => topics.get(params.id)),
      ),
    )
    .handle('create', ({ payload }) => create(payload))
    .handle('update', ({ params, payload }) => Effect.andThen(confineTopic(params.id), updateTopic(params.id, payload)))
    .handle('setSetup', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(confineTopic(params.id), confineSetupEdit(payload)),
        editTopicSetup(params.id, payload),
      ),
    ),
)
