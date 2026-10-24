import type { CreateTopic, Need, UpdateTopic } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  KEY_TOPIC_SETUP,
  claim,
  confineSetup,
  confineSetupEdit,
  listedBy,
  namesAnything,
  reachesTopic,
  requestCredential,
  requestKey,
  requireAccessFor,
  requireAdminFor,
} from '../grants/policy.ts'
import { Forbidden } from '../http/errors.ts'
import { createTopic, editTopicSetup, madeTopic, updateTopic } from './program.ts'
import { Topics } from './service.ts'

/** How many Topics a page answers when the caller names no limit. */
const PAGE = 50

/** A page of Topics: every one for a member, those its grant reaches for a credential (ADR 0114). */
const list = (query: { readonly cursor?: string | undefined; readonly limit?: number | undefined }) =>
  Effect.gen(function* () {
    const grant = yield* listedBy('topics')
    return yield* Topics.use((topics) =>
      topics.page({
        ...(grant === undefined ? {} : { grant }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit ?? PAGE,
      }),
    )
  })

/** What making `input` needs of a credential's grant beyond `write`: `manage` for guidance, `setup` for a setup. */
const needOf = (input: CreateTopic): Partial<Need> => ({
  ...(input.description !== undefined || input.instructions !== undefined ? { level: 'manage' } : {}),
  ...(namesAnything(input.setup) ? { extra: 'setup' } : {}),
})

/** The Topic a credential makes: a key's names nothing in its setup unless it says, so it starts with its chats alone. */
const credentialTopic = (input: CreateTopic, keyed: boolean): CreateTopic =>
  input.setup !== undefined || !keyed ? input : { ...input, setup: KEY_TOPIC_SETUP }

/**
 * What changing a Topic takes beyond its endpoint (an owner or admin, or a credential's `manage`) and reaching it: making
 * it the hub takes a person, never a credential, so what a credential's content steers can never be read from
 * everywhere (ADR 0115).
 */
const updating = (change: UpdateTopic) =>
  Effect.gen(function* () {
    if (change.reach === 'hub' && (yield* requestCredential) !== undefined)
      return yield* new Forbidden({ reason: 'hub_person' })
  })

const create = (input: CreateTopic) =>
  Effect.gen(function* () {
    yield* requireAdminFor(
      input.description !== undefined || input.instructions !== undefined || input.setup !== undefined,
    )
    if ((yield* requestCredential) === undefined) return yield* createTopic(input, { actor: 'owner' })
    yield* requireAccessFor(needOf(input), false)
    const key = yield* requestKey
    const making = credentialTopic(input, key !== undefined)
    if (making.setup !== undefined) yield* confineSetup(making.setup)
    const made = yield* madeTopic(making, { actor: 'owner' })
    yield* claim('topic', made.topic.id, made.created)
    return yield* Topics.use((topics) => topics.get(made.topic.id))
  })

/**
 * The `topics` group (ADR 0032), the reference the other groups copy: each handler runs its program. Owner admission
 * has already admitted the request; a program's `AppError` is answered in its envelope, and services come from the
 * agent's runtime. A request a credential sent reaches only the Topics its grant reaches (ADR 0114).
 */
export const TopicsHandlers = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
  handlers
    .handle('list', ({ query }) => list(query))
    .handle('get', ({ params }) =>
      Effect.andThen(
        reachesTopic(params.id),
        Topics.use((topics) => topics.get(params.id)),
      ),
    )
    .handle('create', ({ payload }) => create(payload))
    .handle('update', ({ params, payload }) =>
      Effect.andThen(Effect.andThen(reachesTopic(params.id), updating(payload)), updateTopic(params.id, payload)),
    )
    .handle('setSetup', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(reachesTopic(params.id), confineSetupEdit(payload)),
        editTopicSetup(params.id, payload),
      ),
    ),
)
