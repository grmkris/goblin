import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { NonEmptyString } from '../ids.ts'
import { CreatePersona, PersonaDetail, PersonaPage, PersonaReply, PersonaView, UpdatePersona } from '../personas.ts'
import { ApiErrors } from './errors.ts'
import { EndpointScope } from './scope.ts'
import { PageQuery } from './page.ts'

/** A Persona's id in a path: 1 to 999999999. */
const PersonaParam = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))

/** `?name=` with a page's `?cursor=&limit=`: only Personas whose name holds `name`, ignoring case. */
const PersonaQuery = { ...PageQuery, name: Schema.optional(NonEmptyString(32)) }

/**
 * The owner's Personas (ADR 0033): named, versioned agent definitions. Paths are relative to the API's `/api` prefix.
 *
 * - `list`: `GET /api/personas?name=&cursor=&limit=`, a page of Personas, newest change first, each with its setup in
 *   a line: every one for the owner, a key's own for a key.
 * - `create`: `POST /api/personas`, 201 with the Persona as it is now. The same operation id finds the same Persona. A
 *   name another active Persona has is a conflict; a model the deployment does not offer is invalid input.
 * - `detail`: `GET /api/personas/:id`, one Persona with its revisions, newest first.
 * - `update`: `PATCH /api/personas/:id` writes a new revision. `expectedRevision` must be the current one (a conflict
 *   otherwise), and the name and model rules of `create` apply.
 * - `reply`: `POST /api/personas/reply`, 202: the owner's reply to a Persona's hold (ADR 0041) goes to its fork, and the
 *   Persona answers again in the chat it was asked in. A fork that is not a Persona's, or whose chat is closed, refuses.
 *
 * An API key with the `personas` scope reaches `list`, `create`, `detail` and `update` for its own Personas, never
 * `reply` (ADRs 0081, 0084).
 */
export class PersonasGroup extends HttpApiGroup.make('personas').add(
  HttpApiEndpoint.get('list', '/personas', { query: PersonaQuery, success: PersonaPage }).annotate(
    EndpointScope,
    'personas',
  ),
  HttpApiEndpoint.post('create', '/personas', {
    payload: CreatePersona,
    success: PersonaView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.conflict, ApiErrors.invalidInput],
  }).annotate(EndpointScope, 'personas'),
  HttpApiEndpoint.get('detail', '/personas/:id', {
    params: { id: PersonaParam },
    success: PersonaDetail,
    error: ApiErrors.notFound,
  }).annotate(EndpointScope, 'personas'),
  HttpApiEndpoint.patch('update', '/personas/:id', {
    params: { id: PersonaParam },
    payload: UpdatePersona,
    success: PersonaView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }).annotate(EndpointScope, 'personas'),
  HttpApiEndpoint.post('reply', '/personas/reply', {
    payload: PersonaReply,
    success: Schema.Null.pipe(HttpApiSchema.status(202)),
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
) {}
