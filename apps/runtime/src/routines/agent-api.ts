import { PERSONAL_TOPIC } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { chooseOwnerModel } from '../agent-model.ts'
import { Budget } from '../budget.ts'
import { reachesTopic, requestKey } from '../grants/policy.ts'
import { Models } from '../models.ts'
import { Inference } from '../inference/service.ts'
import { epochSeconds } from '../clock.ts'
import { askAgent, recentOwnerMessages } from '../inbound/program.ts'

/** The model choice as the request's caller reads it: a server's key never sees the owner's own subscriptions (ADR 0087). */
const choiceFor = Effect.flatMap(requestKey, (key) =>
  Models.use((models) => (key === undefined ? models.choice : models.choiceForServers)),
)

/**
 * The `agent` group: today's usage, the model and its endpoint, the models a Persona may name, and a caller's question
 * in main with main's recent messages (ADR 0086). Each handler runs its program; owner admission has already admitted
 * the request.
 */
export const AgentHandlers = HttpApiBuilder.group(OwnerApi, 'agent', (handlers) =>
  handlers
    .handle('usage', () => Effect.flatMap(epochSeconds, (now) => Budget.use((budget) => budget.today(now))))
    .handle('model', () => choiceFor)
    .handle('chooseModel', ({ payload }) => chooseOwnerModel(payload.model))
    .handle('modelEndpoint', () => Inference.use((inference) => inference.view))
    .handle('setModelEndpoint', ({ payload }) =>
      Effect.flatMap(epochSeconds, (now) => Inference.use((inference) => inference.setOwner(payload, now))),
    )
    .handle('clearModelEndpoint', () => Inference.use((inference) => inference.clearOwner))
    // Main is Personal's Conversation: a credential asks or reads it only when its grant reaches Personal (ADR 0114).
    .handle('ask', ({ payload }) => Effect.andThen(reachesTopic(PERSONAL_TOPIC), askAgent(payload)))
    .handle('recent', ({ query }) =>
      Effect.andThen(
        reachesTopic(PERSONAL_TOPIC),
        Effect.map(recentOwnerMessages(query.limit), (messages) => ({ messages })),
      ),
    )
    .handle('models', () =>
      Effect.map(choiceFor, (choice) => ({
        ...(choice.default === undefined ? {} : { default: choice.default }),
        models: choice.options,
      })),
    ),
)
