import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import {
  AgentAsk,
  AskResult,
  ModelChoice,
  ModelEndpointInput,
  ModelEndpointView,
  ModelOffer,
  TranscriptMessage,
  UsageToday,
} from '../agent.ts'
import { NonEmptyString } from '../ids.ts'
import { ApiErrors } from './errors.ts'
import { EndpointAccess } from './access.ts'
import { EndpointRole } from './role.ts'

/** `?limit=`: how many of the newest messages, 1 to 50. */
const RecentQuery = {
  limit: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
}

/** The owner's pick of a model the deployment offers. */
const ModelPick = Schema.Struct({ model: NonEmptyString(128) })
/**
 * The agent itself: today's usage and its model. Paths are relative to the
 * API's `/api` prefix; every endpoint can also answer owner admission's failures, and `error` names the ones the
 * endpoint itself produces.
 *
 * - `usage`: `GET /api/agent/usage`, today's model tokens and the deployment's daily cap.
 * - `model`, `chooseModel`: `GET`/`PUT /api/agent/model`. A pick moves main at once; other threads follow on their
 *   next turn. A model the endpoint does not offer is invalid input.
 * - `modelEndpoint`, `setModelEndpoint`, `clearModelEndpoint`: `GET`/`PUT`/`DELETE /api/agent/model-endpoint`, the
 *   owner's own model endpoint (ADR 0059). Setting one lists its models with the key first: a URL that is not public
 *   https, a refused key or an answer that is not a model list is invalid input. Clearing goes back to the
 *   deployment's.
 * - `models`: `GET /api/models`, the models a Persona may name now. A credential reaches it with `read` (ADR 0084), so
 *   a server can check a model before it writes a Persona.
 * - `ask`: `POST /api/agent/ask`, a question for the agent in main, labelled with the caller's name, answered when it
 *   settles within `waitMs` (else `running`, to ask again with the same operation id). It needs current resident
 *   authority and never grants it.
 * - `recent`: `GET /api/agent/recent?limit=`, the newest messages of main.
 *
 * A credential reaches `ask` with `write` and `recent` with `read` (ADRs 0086, 0114); both are main's, Personal's
 * Conversation, so its grant must reach Personal (Topic 1).
 */
export class AgentGroup extends HttpApiGroup.make('agent').add(
  HttpApiEndpoint.get('usage', '/agent/usage', { success: UsageToday }),
  HttpApiEndpoint.get('model', '/agent/model', { success: ModelChoice }),
  HttpApiEndpoint.put('chooseModel', '/agent/model', {
    payload: ModelPick,
    success: ModelChoice,
    error: [ApiErrors.invalidInput],
  }).annotate(EndpointRole, 'admin'),
  HttpApiEndpoint.get('modelEndpoint', '/agent/model-endpoint', { success: ModelEndpointView }).annotate(
    EndpointRole,
    'admin',
  ),
  HttpApiEndpoint.put('setModelEndpoint', '/agent/model-endpoint', {
    payload: ModelEndpointInput,
    success: ModelEndpointView,
    error: [ApiErrors.invalidInput],
  }).annotate(EndpointRole, 'admin'),
  HttpApiEndpoint.delete('clearModelEndpoint', '/agent/model-endpoint', { success: ModelEndpointView }).annotate(
    EndpointRole,
    'admin',
  ),
  HttpApiEndpoint.get('models', '/models', { success: ModelOffer }).annotate(EndpointAccess, { level: 'read' }),
  HttpApiEndpoint.post('ask', '/agent/ask', {
    payload: AgentAsk,
    success: AskResult,
    error: [ApiErrors.conflict, ApiErrors.budgetExhausted],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.get('recent', '/agent/recent', {
    query: RecentQuery,
    success: Schema.Struct({ messages: Schema.Array(TranscriptMessage) }),
  }).annotate(EndpointAccess, { level: 'read' }),
) {}
