import type { ModelEndpointView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import { Budget, dailyTokenCap, recordUse, refuseSpent, usageLedger, utcDay } from '../budget.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import { endpointBase, keyHint, listModels } from '../inference/endpoint.ts'
import { Inference, type ResolvedEndpoint } from '../inference/service.ts'
import { endpointStore } from '../inference/store.ts'
import { Cipher } from '../mcp/cipher.ts'
import { ModelChoiceStore, ModelPicker, type ModelOptions, Models, modelOptions, optionOf } from '../models.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

/** The endpoint's models as the picker offers them, its default first. */
const optionsOf = (endpoint: ResolvedEndpoint): ModelOptions => {
  const [first, ...rest] = endpoint.models
  return [optionOf(first), ...rest.map(optionOf)]
}

/**
 * The owner's model endpoint (ADR 0059) over the agent's SQLite, its key sealed with the credential cipher and bound to
 * the agent; without one, the deployment's. The endpoint in use is kept in memory until the owner changes it.
 */
const InferenceLive: Layer.Layer<Inference, never, AgentInput | Db | Cipher> = Layer.effect(
  Inference,
  Effect.gen(function* () {
    const { env, userId, mcpFetch } = yield* AgentInput
    const store = endpointStore(yield* Db)
    const cipher = yield* Cipher
    const aad = `model-endpoint:${userId}`
    const [first, ...rest] = modelOptions(env.MODELS, env.MODEL_ID).map((option) => option.id)
    const deployment: ResolvedEndpoint = {
      source: 'deployment',
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_KEY,
      models: [first ?? env.MODEL_ID, ...rest],
    }
    const kept = yield* Ref.make<ResolvedEndpoint | undefined>(undefined)
    const endpoint = Effect.gen(function* () {
      const known = yield* Ref.get(kept)
      if (known !== undefined) return known
      const stored = yield* Effect.sync(() => store.get())
      const resolved: ResolvedEndpoint =
        stored === undefined
          ? deployment
          : {
              source: 'owner',
              baseUrl: stored.baseUrl,
              apiKey: yield* attempt(() => cipher.decrypt(stored.keySealed, aad)),
              models: stored.models,
            }
      yield* Ref.set(kept, resolved)
      return resolved
    }).pipe(Effect.withSpan('Inference.endpoint'))
    const view = Effect.map(endpoint, (current): ModelEndpointView =>
      current.source === 'owner'
        ? { source: 'owner', baseUrl: current.baseUrl, keyHint: keyHint(current.apiKey), models: current.models }
        : { source: 'deployment', models: current.models },
    )
    return Inference.of({
      endpoint,
      served: Effect.fn('Inference.served')(function* (modelId: string) {
        const current = yield* endpoint
        const model = current.models.includes(modelId) ? modelId : current.models[0]
        return { baseUrl: current.baseUrl, apiKey: current.apiKey, model }
      }),
      view,
      setOwner: Effect.fn('Inference.setOwner')(function* (input, now) {
        const baseUrl = yield* attemptSync(() => endpointBase(input.baseUrl))
        const [model, ...others] = yield* attempt(() => listModels(baseUrl, input.key, mcpFetch))
        if (model === undefined) return yield* view
        const keySealed = yield* attempt(() => cipher.encrypt(input.key, aad))
        yield* Effect.sync(() => store.set({ baseUrl, keySealed, models: [model, ...others] }, now))
        yield* Ref.set(kept, undefined)
        return yield* view
      }),
      clearOwner: Effect.gen(function* () {
        yield* Effect.sync(() => store.clear())
        yield* Ref.set(kept, undefined)
        return yield* view
      }).pipe(Effect.withSpan('Inference.clearOwner')),
    })
  }),
)

/**
 * Today's model usage in tokens over the agent's usage ledger, against the deployment's optional daily cap. The cap
 * holds for the deployment's endpoint only: the owner's own endpoint is theirs to pay for.
 */
const BudgetLive: Layer.Layer<Budget, never, AgentInput | Db | Inference> = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const ledger = usageLedger(yield* Db)
    const { env } = yield* AgentInput
    const inference = yield* Inference
    const cap = dailyTokenCap(env.DAILY_TOKEN_CAP)
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const { day, resetsAt } = utcDay(now)
      const used = yield* attemptSync(() => ledger.tokens(day))
      const limit = (yield* inference.endpoint).source === 'owner' ? null : cap
      return { used, limit, resetsAt }
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now) {
        yield* Effect.sync(() => recordUse(ledger, use, now))
      }),
      require: Effect.fn('Budget.require')(function* (now: number) {
        yield* refuseSpent(yield* today(now))
      }),
    })
  }),
)

/** The model picker over the agent's SQLite: the owner's pick among what their model endpoint offers. */
const ModelsLive: Layer.Layer<Models, never, Db | Inference> = Layer.effect(
  Models,
  Effect.gen(function* () {
    const ledger = new ModelChoiceStore(yield* Db)
    const inference = yield* Inference
    const picker = Effect.map(inference.endpoint, (endpoint) => new ModelPicker(ledger, optionsOf(endpoint)))
    return Models.of({
      current: Effect.map(picker, (models) => models.current()).pipe(Effect.withSpan('Models.current')),
      choice: Effect.map(picker, (models) => models.choice()).pipe(Effect.withSpan('Models.choice')),
      choose: Effect.fn('Models.choose')(function* (modelId: string, now: number) {
        const models = yield* picker
        return yield* attemptSync(() => models.choose(modelId, now))
      }),
    })
  }),
)

/**
 * The model endpoint, the daily model usage and the model picker, over the agent's SQLite. A send's admission reads
 * them, so `layers/index.ts` builds them before the conversation layer.
 */
export const ModelBudgetLive: Layer.Layer<Inference | Budget | Models, never, AgentInput | Db | Cipher> =
  Layer.mergeAll(BudgetLive, ModelsLive).pipe(Layer.provideMerge(InferenceLive))
