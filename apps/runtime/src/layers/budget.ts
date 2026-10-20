import type { ModelEndpointView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import type { RuntimeEnv } from '../env.ts'
import { Budget, dailyTokenCap, recordUse, refuseSpent, usageLedger, utcDay } from '../budget.ts'
import { NoModelEndpoint, attempt, attemptSync } from '../http/errors.ts'
import { endpointBase, keyHint, listModels } from '../inference/endpoint.ts'
import { type CurrentEndpoint, Inference, type ResolvedEndpoint } from '../inference/service.ts'
import { endpointStore } from '../inference/store.ts'
import { Cipher } from '../mcp/oauth/cipher.ts'
import {
  ModelChoiceStore,
  ModelPicker,
  type ModelOptions,
  Models,
  offeredEndpoint,
  optionOf,
  ownerModelIds,
} from '../models.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

/** The endpoint's models as the picker offers them, its default first. */
const optionsOf = (endpoint: ResolvedEndpoint): ModelOptions => {
  const [first, ...rest] = endpoint.models
  return [optionOf(first), ...rest.map(optionOf)]
}

/**
 * The deployment's own endpoint as account `userId`'s model calls use it (its owner's subscriptions included for the
 * owner alone, ADR 0087), or `none` when it has none (ADR 0064).
 */
const deploymentOf = (env: RuntimeEnv, userId: string): CurrentEndpoint => {
  const own = offeredEndpoint(env, userId)
  if (own === undefined) return { source: 'none' }
  const [first, ...rest] = own.options
  return {
    source: 'deployment',
    baseUrl: own.baseUrl,
    apiKey: own.apiKey,
    models: [first.id, ...rest.map((o) => o.id)],
  }
}

/**
 * The owner's model endpoint (ADR 0059) over the agent's SQLite, its key sealed with the credential cipher and bound to
 * the agent; without one, the deployment's, and without that (ADR 0064) none, which refuses every model call. The
 * endpoint in use is kept in memory until the owner changes it.
 */
const InferenceLive: Layer.Layer<Inference, never, AgentInput | Db | Cipher> = Layer.effect(
  Inference,
  Effect.gen(function* () {
    const { env, userId, mcpFetch } = yield* AgentInput
    const store = endpointStore(yield* Db)
    const cipher = yield* Cipher
    const aad = `model-endpoint:${userId}`
    const deployment = deploymentOf(env, userId)
    const kept = yield* Ref.make<CurrentEndpoint | undefined>(undefined)
    const endpoint = Effect.gen(function* () {
      const known = yield* Ref.get(kept)
      if (known !== undefined) return known
      const stored = yield* Effect.sync(() => store.get())
      const resolved: CurrentEndpoint =
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
    const fallback = deployment.source === 'deployment'
    const view = Effect.map(endpoint, (current): ModelEndpointView => {
      if (current.source === 'none') return { source: 'none', deployment: false, models: [] }
      return current.source === 'owner'
        ? {
            source: 'owner',
            deployment: fallback,
            baseUrl: current.baseUrl,
            keyHint: keyHint(current.apiKey),
            models: current.models,
          }
        : { source: 'deployment', deployment: true, models: current.models }
    })
    return Inference.of({
      endpoint,
      served: Effect.fn('Inference.served')(function* (modelId: string) {
        const current = yield* endpoint
        if (current.source === 'none') return yield* new NoModelEndpoint({})
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
 * holds for the deployment's endpoint only: the owner's own endpoint is theirs to pay for, and without either there is
 * nothing to cap and nothing a model call could reach (`NoModelEndpoint`).
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
      const limit = (yield* inference.endpoint).source === 'deployment' ? cap : null
      return { used, limit, resetsAt }
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now) {
        yield* Effect.sync(() => recordUse(ledger, use, now))
      }),
      require: Effect.fn('Budget.require')(function* (now: number) {
        if ((yield* inference.endpoint).source === 'none') return yield* new NoModelEndpoint({})
        yield* refuseSpent(yield* today(now))
      }),
    })
  }),
)

/**
 * The model picker over the agent's SQLite: the owner's pick among what their model endpoint offers. Without an endpoint
 * there is nothing to pick: the choice offers nothing, and the model in use is `NoModelEndpoint`.
 */
const ModelsLive: Layer.Layer<Models, never, AgentInput | Db | Inference> = Layer.effect(
  Models,
  Effect.gen(function* () {
    const ledger = new ModelChoiceStore(yield* Db)
    const inference = yield* Inference
    const owned = new Set(ownerModelIds((yield* AgentInput).env))
    const ownerOnly = (id: string) => owned.has(id)
    const picker = Effect.map(inference.endpoint, (endpoint) =>
      endpoint.source === 'none' ? undefined : new ModelPicker(ledger, optionsOf(endpoint)),
    )
    const required = Effect.flatMap(picker, (models) =>
      models === undefined ? Effect.fail(new NoModelEndpoint({})) : Effect.succeed(models),
    )
    const choice = Effect.map(picker, (models) => models?.choice() ?? { options: [] }).pipe(
      Effect.withSpan('Models.choice'),
    )
    return Models.of({
      current: Effect.map(required, (models) => models.current()).pipe(Effect.withSpan('Models.current')),
      choice,
      choose: Effect.fn('Models.choose')(function* (modelId: string, now: number) {
        const models = yield* required
        return yield* attemptSync(() => models.choose(modelId, now))
      }),
      ownerOnly,
      forServers: Effect.map(required, (models) => {
        const picked = models.current()
        return ownerOnly(picked) ? models.defaultId() : picked
      }).pipe(Effect.withSpan('Models.forServers')),
      choiceForServers: Effect.map(choice, (offered) => {
        // The default is every account's model (`ownerModelIds` leaves those out), so it stands in for the owner's own.
        const current = offered.current !== undefined && ownerOnly(offered.current) ? offered.default : offered.current
        return {
          ...(current === undefined ? {} : { current }),
          ...(offered.default === undefined ? {} : { default: offered.default }),
          options: offered.options.filter((option) => !ownerOnly(option.id)),
        }
      }).pipe(Effect.withSpan('Models.choiceForServers')),
    })
  }),
)

/**
 * The model endpoint, the daily model usage and the model picker, over the agent's SQLite. A send's admission reads
 * them, so `layers/index.ts` builds them before the conversation layer.
 */
export const ModelBudgetLive: Layer.Layer<Inference | Budget | Models, never, AgentInput | Db | Cipher> =
  Layer.mergeAll(BudgetLive, ModelsLive).pipe(Layer.provideMerge(InferenceLive))
