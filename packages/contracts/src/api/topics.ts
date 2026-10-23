import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { CreateTopic, TopicPage, TopicSetupEdit, TopicSetupSaved, TopicView, UpdateTopic } from '../topics.ts'
import { ApiErrors } from './errors.ts'
import { EndpointAccess } from './access.ts'
import { EndpointRole } from './role.ts'
import { EndpointScope } from './scope.ts'
import { PageQuery } from './page.ts'

/** A Topic's id in a path: 1 to 999999999. */
const TopicParam = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))

/**
 * The owner's Topics (ADR 0032), the reference group the others copy. Paths are relative to the API's `/api` prefix.
 * Every owner endpoint can also answer owner admission's failures (`OwnerAdmission` in `owner.ts`); `error` names the ones
 * the endpoint itself produces. An API key with the `topics` scope reaches every one, for its own Topics only (ADRs
 * 0081, 0084).
 *
 * - `list`: `GET /api/topics?cursor=&limit=`, a page of Topics, newest change first: every one for the owner, a key's
 *   own for a key.
 * - `get`: `GET /api/topics/:id`, one Topic as it is now, with its guidance and setup.
 * - `create`: `POST /api/topics`, 201 with the Topic as it is now. The same operation id finds the same Topic.
 * - `update`: `PATCH /api/topics/:id` renames, archives, restores or changes the search opt-out. A name another active
 *   Topic has is a conflict; archiving Personal is invalid input.
 * - `setSetup`: `PATCH /api/topics/:id/setup` changes what the Topic's chats work with (ADR 0040), and answers the
 *   routines it leaves without some of their tools. A stale `expectedRevision` is a conflict.
 */
export class TopicsGroup extends HttpApiGroup.make('topics')
  .add(
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
    }).annotate(EndpointAccess, { level: 'manage' }),
    HttpApiEndpoint.patch('setSetup', '/topics/:id/setup', {
      params: { id: TopicParam },
      payload: TopicSetupEdit,
      success: TopicSetupSaved,
      error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
    })
      .annotate(EndpointRole, 'admin')
      .annotate(EndpointAccess, { level: 'manage', extra: 'setup' }),
  )
  .annotateEndpoints(EndpointScope, 'topics') {}
