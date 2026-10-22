import type { CreateTopic } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  KEY_TOPIC_SETUP,
  claim,
  confineSetup,
  confineSetupEdit,
  confineTopic,
  requestKey,
  requireAdminFor,
} from '../keys/policy.ts'
import { Setups } from '../setup/service.ts'
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
 * own from then on, a room (ADR 0108) as its answer says. A member's names no description, guidance or setup, which the
 * agent reads as the Topic's purpose and take an admin (ADR 0098).
 */
const create = (input: CreateTopic) =>
  Effect.gen(function* () {
    yield* requireAdminFor(
      input.description !== undefined || input.instructions !== undefined || input.setup !== undefined,
    )
    if ((yield* requestKey) === undefined) return yield* createTopic(input, { actor: 'owner' })
    const keyed = { ...input, setup: input.setup ?? KEY_TOPIC_SETUP }
    yield* confineSetup(keyed.setup)
    const made = yield* madeTopic(keyed, { actor: 'owner' })
    yield* claim('topic', made.topic.id, made.created)
    // Its Conversation was opened before the claim made it a room: it now leaves out what a room does not offer. A
    // replay applies it again, so a create that failed here puts it right.
    yield* Setups.use((setups) => setups.retoolTopic(made.topic.id))
    return yield* Topics.use((topics) => topics.get(made.topic.id))
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
    .handle('update', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(
          confineTopic(params.id),
          requireAdminFor(payload.description !== undefined || payload.instructions !== undefined),
        ),
        updateTopic(params.id, payload),
      ),
    )
    .handle('setSetup', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(confineTopic(params.id), confineSetupEdit(payload)),
        editTopicSetup(params.id, payload),
      ),
    ),
)
