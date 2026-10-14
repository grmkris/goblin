import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { chooseOwnerModel } from '../agent-model.ts'
import { Budget } from '../budget.ts'
import { disableTelegram, enableTelegram } from '../channel/program.ts'
import { Channel } from '../channel/service.ts'
import { channelChats, channelSettings, routeChannel } from '../channel/routing.ts'
import { Models } from '../models.ts'
import { AgentInput } from '../runtime/input.ts'
import { epochSeconds } from '../clock.ts'

/**
 * The `agent` group: today's usage, the model, and the Telegram channel. Each handler runs its program; owner
 * admission has already admitted the request.
 */
export const AgentHandlers = HttpApiBuilder.group(OwnerApi, 'agent', (handlers) =>
  handlers
    .handle('usage', () => Effect.flatMap(epochSeconds, (now) => Budget.use((budget) => budget.today(now))))
    .handle('model', () => Models.use((models) => models.choice))
    .handle('chooseModel', ({ payload }) => chooseOwnerModel(payload.model))
    .handle('channel', () => Channel.use((channel) => channel.status))
    .handle('enableChannel', ({ payload }) =>
      AgentInput.use(({ schedulePull }) => enableTelegram(payload.connectionId, schedulePull)),
    )
    .handle('disableChannel', () => disableTelegram)
    .handle('channelChats', () => channelChats)
    .handle('routeChannel', ({ payload }) => routeChannel(payload))
    .handle('channelSettings', ({ payload }) => channelSettings(payload.newChats)),
)
