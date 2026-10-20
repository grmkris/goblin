import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { chooseOwnerModel } from '../agent-model.ts'
import { Budget } from '../budget.ts'
import { Models } from '../models.ts'
import { Inference } from '../inference/service.ts'
import { epochSeconds } from '../clock.ts'

/**
 * The `agent` group: today's usage, the model and its endpoint, and the models a Persona may name. Each handler runs
 * its program; owner admission has already admitted the request.
 */
export const AgentHandlers = HttpApiBuilder.group(OwnerApi, 'agent', (handlers) =>
  handlers
    .handle('usage', () => Effect.flatMap(epochSeconds, (now) => Budget.use((budget) => budget.today(now))))
    .handle('model', () => Models.use((models) => models.choice))
    .handle('chooseModel', ({ payload }) => chooseOwnerModel(payload.model))
    .handle('modelEndpoint', () => Inference.use((inference) => inference.view))
    .handle('setModelEndpoint', ({ payload }) =>
      Effect.flatMap(epochSeconds, (now) => Inference.use((inference) => inference.setOwner(payload, now))),
    )
    .handle('clearModelEndpoint', () => Inference.use((inference) => inference.clearOwner))
    .handle('models', () =>
      Effect.map(
        Models.use((models) => models.choice),
        (choice) => ({
          ...(choice.default === undefined ? {} : { default: choice.default }),
          models: choice.options,
        }),
      ),
    ),
)
