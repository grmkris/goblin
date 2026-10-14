import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget, dailyTokenCap, recordUse, refuseSpent, usageLedger, utcDay } from '../budget.ts'
import { attemptSync } from '../http/errors.ts'
import { ModelChoiceStore, ModelPicker, Models, modelOptions } from '../models.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

type Method<Args extends readonly unknown[], A> = (...args: Args) => A

/** A store method that throws its typed failures: an `AppError` (anything else `Internal`), never a defect. */
const trySync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attemptSync(() => method(...args))
  })

/** A method with no typed failure: a read callers run with `useSync`, where a throw is a defect. */
const sync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.sync(() => method(...args))
  })

/** Today's model usage in tokens over the agent's usage ledger, against the deployment's optional daily cap. */
const BudgetLive = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const ledger = usageLedger(yield* Db)
    const { env } = yield* AgentInput
    const limit = dailyTokenCap(env.DAILY_TOKEN_CAP)
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const { day, resetsAt } = utcDay(now)
      const used = yield* attemptSync(() => ledger.tokens(day))
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

/** The model picker over the agent's SQLite: the owner's pick among what the deployment offers. */
const ModelsLive: Layer.Layer<Models, never, AgentInput | Db> = Layer.effect(
  Models,
  Effect.gen(function* () {
    const { env } = yield* AgentInput
    const models = new ModelPicker(new ModelChoiceStore(yield* Db), modelOptions(env.MODELS, env.MODEL_ID))
    return Models.of({
      current: sync('Models.current', models.current.bind(models))(),
      choice: sync('Models.choice', models.choice.bind(models))(),
      choose: trySync('Models.choose', models.choose.bind(models)),
    })
  }),
)

/**
 * The daily model usage and the model picker, over the agent's SQLite (they keep no state of their own). A send's
 * admission reads them, so `layers/index.ts` builds them before the conversation layer.
 */
export const ModelBudgetLive: Layer.Layer<Budget | Models, never, AgentInput | Db> = Layer.mergeAll(
  BudgetLive,
  ModelsLive,
)
