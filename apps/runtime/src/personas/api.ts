import { type CreatePersona, type PersonaPage, type PersonaView, setupSummaryOf } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  claim,
  confineSetup,
  listedBy,
  namesAnything,
  reachesPersona,
  requestCredential,
  requestApp,
  requireAccessFor,
} from '../grants/policy.ts'
import { InvalidInput } from '../http/errors.ts'
import { Resident } from '../mcp/service.ts'
import { resumePersona } from './ask.ts'
import { createPersona, madePersona, personaDetail, updatePersona } from './program.ts'
import { Personas } from './service.ts'

/** How many Personas a page answers when the caller names no limit. */
const PAGE = 50

const summaryOf = (persona: PersonaView): PersonaPage['personas'][number] => ({
  id: persona.id,
  name: persona.name,
  role: persona.role,
  avatar: persona.avatar,
  ...(persona.madeBy === undefined ? {} : { madeBy: persona.madeBy }),
  revision: persona.revision,
  ...(persona.model === undefined ? {} : { model: persona.model }),
  ...(persona.thinking === undefined ? {} : { thinking: persona.thinking }),
  ...(persona.tools === undefined ? {} : { tools: persona.tools }),
  setup: setupSummaryOf(persona.setup),
  ...(persona.archivedAt === undefined ? {} : { archivedAt: persona.archivedAt }),
  updatedAt: persona.updatedAt,
})

/** A page of Personas: every one for a member, those its grant reaches for a credential (ADR 0114). */
const list = (query: {
  readonly name?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) =>
  Effect.gen(function* () {
    const grant = yield* listedBy('personas')
    const page = yield* Personas.use((personas) =>
      personas.page({
        ...(grant === undefined ? {} : { grant }),
        ...(query.name === undefined ? {} : { name: query.name }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit ?? PAGE,
      }),
    )
    return { personas: page.personas.map(summaryOf), ...(page.next === undefined ? {} : { next: page.next }) }
  })

/**
 * To an installed app the owner's own subscriptions are not on offer, so a Persona it writes never names one (ADR
 * 0087).
 */
const confineModel = (model: string | null | undefined) =>
  Effect.gen(function* () {
    if (model === undefined || model === null || (yield* requestApp) === undefined) return
    if ((yield* Personas).ownerOnly(model)) return yield* new InvalidInput({ reason: 'persona_model' })
  })

/**
 * A credential's setup for a Persona (ADR 0114): one that gives anything takes the `setup` extra, and it names only
 * connections in reach.
 */
const confinePersonaSetup = (setup: CreatePersona['setup']) =>
  setup === undefined
    ? Effect.void
    : Effect.andThen(
        namesAnything(setup) ? requireAccessFor({ extra: 'setup' }, false) : Effect.void,
        confineSetup(setup),
      )

/**
 * A Persona a credential makes (ADR 0114): its setup within its grant, and within its reach from then on (listed when
 * its Personas are a list); an installed app's is named as made by it (`madeBy`, for display, ADR 0115).
 */
const create = (input: CreatePersona) =>
  Effect.gen(function* () {
    if ((yield* requestCredential) === undefined) return yield* createPersona(input, { actor: 'owner' })
    yield* confineModel(input.model)
    yield* confinePersonaSetup(input.setup)
    const made = yield* madePersona(input, { actor: 'owner' })
    yield* claim('persona', made.persona.id, made.created)
    return yield* Personas.use((personas) => personas.get(made.persona.id))
  })

/**
 * The `personas` group (ADR 0033): each handler runs its program as the owner. Owner admission has already admitted
 * the request; a reply to a Persona's hold (ADR 0041) is admitted again as an owner message is. A request a credential
 * sent reaches only the Personas its grant reaches (ADR 0114).
 */
export const PersonasHandlers = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
  handlers
    .handle('list', ({ query }) => list(query))
    .handle('create', ({ payload }) => create(payload))
    .handle('detail', ({ params }) => Effect.andThen(reachesPersona(params.id), personaDetail(params.id)))
    .handle('update', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(
          Effect.andThen(reachesPersona(params.id), confineModel(payload.model)),
          confinePersonaSetup(payload.setup),
        ),
        updatePersona(params.id, payload, { actor: 'owner' }),
      ),
    )
    .handle('reply', ({ payload }) =>
      Effect.gen(function* () {
        // The reply makes the Persona work again: the same admission an owner message gets.
        yield* Resident.use((resident) => resident.grant())
        yield* resumePersona(payload.fork, payload.operationId, payload.text)
        return null
      }),
    ),
)
