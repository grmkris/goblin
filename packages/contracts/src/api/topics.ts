import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { CreateTopic, TopicPage, TopicSetupEdit, TopicSetupSaved, TopicView, UpdateTopic } from '../topics.ts'
import { ApiErrors } from './errors.ts'
import { EndpointAccess } from './access.ts'
import { EndpointRole } from './role.ts'
import { PageQuery } from './page.ts'

/** A Topic's id in a path: 1 to 999999999. */
const TopicParam = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))

/**
 * The owner's Topics (ADR 0032), the reference group the others copy. Paths are relative to the API's `/api` prefix.
 * Every owner endpoint can also answer owner admission's failures (`OwnerAdmission` in `owner.ts`); `error` names the ones
 * the endpoint itself produces. A credential reaches every one within its grant's reach (ADRs 0081, 0084, 0114): `list`
 * and `get` with `read`, `create` with `write` (and `manage` for guidance, `setup` for a setup; a Topic it makes is
 * added to a list it has), `update` with `manage` and `setSetup` with `manage` and `setup`.
 *
 * - `list`: `GET /api/topics?cursor=&limit=`, a page of Topics, newest change first: every one for a member, those its
 *   grant reaches for a credential.
 * - `get`: `GET /api/topics/:id`, one Topic as it is now, with its guidance and setup.
 * - `create`: `POST /api/topics`, 201 with the Topic as it is now. The same operation id finds the same Topic.
 * - `update`: `PATCH /api/topics/:id` renames, archives, restores, or changes its guidance or whether it is the hub
 *   (ADR 0115): an owner's or admin's, as a member's turn has no such tools. A name another active Topic has is a
 *   conflict; archiving Personal is invalid input.
 * - `setSetup`: `PATCH /api/topics/:id/setup` changes what the Topic's chats work with (ADR 0040), and answers the
 *   routines it leaves without some of their tools. A stale `expectedRevision` is a conflict.
 */
export class TopicsGroup extends HttpApiGroup.make('topics').add(
  HttpApiEndpoint.get('list', '/topics', { query: PageQuery, success: TopicPage }).annotate(EndpointAccess, {
    level: 'read',
  }),
  HttpApiEndpoint.get('get', '/topics/:id', {
    params: { id: TopicParam },
    success: TopicView,
    error: ApiErrors.notFound,
  }).annotate(EndpointAccess, { level: 'read' }),
  HttpApiEndpoint.post('create', '/topics', {
    payload: CreateTopic,
    success: TopicView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.conflict, ApiErrors.invalidInput],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.patch('update', '/topics/:id', {
    params: { id: TopicParam },
    payload: UpdateTopic,
    success: TopicView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  })
    .annotate(EndpointRole, 'admin')
    .annotate(EndpointAccess, { level: 'manage' }),
  HttpApiEndpoint.patch('setSetup', '/topics/:id/setup', {
    params: { id: TopicParam },
    payload: TopicSetupEdit,
    success: TopicSetupSaved,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  })
    .annotate(EndpointRole, 'admin')
    .annotate(EndpointAccess, { level: 'manage', extra: 'setup' }),
) {}
