import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChannelStatus, ModelChoice, ModelEndpointInput, ModelEndpointView, UsageToday } from '../agent.ts'
import { NonEmptyString } from '../ids.ts'
import { RoutePick, TelegramChat, TelegramChats, TelegramSettings } from '../telegram.ts'
import { ApiErrors } from './errors.ts'

/** The owner's pick of a model the deployment offers. */
const ModelPick = Schema.Struct({ model: NonEmptyString(128) })
/** The connection to carry Telegram: a myagent connection bound to the agent's own bot. */
const ChannelPick = Schema.Struct({ connectionId: NonEmptyString(64) })

/**
 * The agent itself: today's usage, its model, and its Telegram channel. Paths are relative to the
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
 * - `channel`: `GET /api/agent/channel`, the connection carrying Telegram (ADR 0009), or null when it is off.
 * - `enableChannel`: `PUT /api/agent/channel` grants the connection's channel tools and subscribes its Events (or the
 *   legacy doorbell). A connection that lacks a tool is invalid input.
 * - `disableChannel`: `DELETE /api/agent/channel`, answered with null.
 * - `channelChats`: `GET /api/agent/channel/chats`, every chat and forum topic the channel reaches with its route
 *   (ADR 0055), read fresh from the server's chat list; invalid input while the channel is off.
 * - `routeChannel`: `PUT /api/agent/channel/routes` sets where one chat or topic goes and who answers there, answers
 *   goblin's open offer for it and delivers what was held. A Topic or Persona that is gone or archived is not found.
 * - `channelSettings`: `PUT /api/agent/channel/settings`, what goblin does with chats it has not seen before.
 */
export class AgentGroup extends HttpApiGroup.make('agent').add(
  HttpApiEndpoint.get('usage', '/agent/usage', { success: UsageToday }),
  HttpApiEndpoint.get('model', '/agent/model', { success: ModelChoice }),
  HttpApiEndpoint.put('chooseModel', '/agent/model', {
    payload: ModelPick,
    success: ModelChoice,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('modelEndpoint', '/agent/model-endpoint', { success: ModelEndpointView }),
  HttpApiEndpoint.put('setModelEndpoint', '/agent/model-endpoint', {
    payload: ModelEndpointInput,
    success: ModelEndpointView,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.delete('clearModelEndpoint', '/agent/model-endpoint', { success: ModelEndpointView }),
  HttpApiEndpoint.get('channel', '/agent/channel', { success: ChannelStatus }),
  HttpApiEndpoint.put('enableChannel', '/agent/channel', {
    payload: ChannelPick,
    success: ChannelStatus,
    error: [ApiErrors.invalidInput, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
  HttpApiEndpoint.delete('disableChannel', '/agent/channel', { success: Schema.Null }),
  HttpApiEndpoint.get('channelChats', '/agent/channel/chats', {
    success: TelegramChats,
    error: [ApiErrors.invalidInput, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
  HttpApiEndpoint.put('routeChannel', '/agent/channel/routes', {
    payload: RoutePick,
    success: TelegramChat,
    error: [ApiErrors.invalidInput, ApiErrors.notFound, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
  HttpApiEndpoint.put('channelSettings', '/agent/channel/settings', {
    payload: TelegramSettings,
    success: ChannelStatus,
    error: [ApiErrors.invalidInput],
  }),
) {}
