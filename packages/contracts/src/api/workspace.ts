import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { GrantsResident } from './resident.ts'
import { EventStream } from './stream.ts'

/**
 * The owner's workspace as one live feed. Paths are relative to the API's `/api` prefix; it does not grant resident
 * authority.
 *
 * - `events`: `GET /api/workspace/events`, server-sent: `event: snapshot` with every conversation, App, Topic, Persona,
 *   organizing receipt and notification as it is now, then `event: change` batches as they happen. It stays open until
 *   the browser goes away.
 */
export class WorkspaceGroup extends HttpApiGroup.make('workspace')
  .add(HttpApiEndpoint.get('events', '/workspace/events', { success: EventStream }))
  .annotateEndpoints(GrantsResident, false) {}
