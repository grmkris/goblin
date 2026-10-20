import { type CreatePersona, type PersonaPage, type PersonaView, setupSummaryOf } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { claim, confinePersona, confineSetup, requestKey } from '../keys/policy.ts'
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
  revision: persona.revision,
  ...(persona.model === undefined ? {} : { model: persona.model }),
  setup: setupSummaryOf(persona.setup),
  ...(persona.archivedAt === undefined ? {} : { archivedAt: persona.archivedAt }),
  updatedAt: persona.updatedAt,
})

/** A page of Personas: every one for the owner, only its own for a server's API key (ADR 0084). */
const list = (query: {
  readonly name?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) =>
  Effect.gen(function* () {
    const key = yield* requestKey
    const page = yield* Personas.use((personas) =>
      personas.page({
        ...(key === undefined ? {} : { key: key.keyId }),
        ...(query.name === undefined ? {} : { name: query.name }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit ?? PAGE,
      }),
    )
    return { personas: page.personas.map(summaryOf), ...(page.next === undefined ? {} : { next: page.next }) }
  })

/** To a server's key the owner's own subscriptions are not on offer, so a Persona it writes never names one (ADR 0087). */
const confineModel = (model: string | null | undefined) =>
  Effect.gen(function* () {
    if (model === undefined || model === null || (yield* requestKey) === undefined) return
    if ((yield* Personas).ownerOnly(model)) return yield* new InvalidInput({ reason: 'persona_model' })
  })

/** A Persona a server's API key makes (ADR 0081): its setup under the key's ceiling, and the key's own from then on. */
const create = (input: CreatePersona) =>
  Effect.gen(function* () {
    if ((yield* requestKey) === undefined) return yield* createPersona(input, { actor: 'owner' })
    yield* confineModel(input.model)
    if (input.setup !== undefined) yield* confineSetup(input.setup)
    const made = yield* madePersona(input, { actor: 'owner' })
    yield* claim('persona', made.persona.id, made.created)
    return made.persona
  })

/**
 * The `personas` group (ADR 0033): each handler runs its program as the owner. Owner admission has already admitted
 * the request; a reply to a Persona's hold (ADR 0041) is admitted again as an owner message is. A request an API key
 * sent reaches only the key's own Personas (ADR 0081).
 */
export const PersonasHandlers = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
  handlers
    .handle('list', ({ query }) => list(query))
    .handle('create', ({ payload }) => create(payload))
    .handle('detail', ({ params }) => Effect.andThen(confinePersona(params.id), personaDetail(params.id)))
    .handle('update', ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(
          Effect.andThen(confinePersona(params.id), confineModel(payload.model)),
          payload.setup === undefined ? Effect.void : confineSetup(payload.setup),
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
