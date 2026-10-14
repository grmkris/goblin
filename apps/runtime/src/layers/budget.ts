import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import { Entitlements } from '../billing/gates.ts'
import { Budget, recordUse, usageLedger, utcDay } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { BudgetExhausted, attemptSync } from '../http/errors.ts'
import { ModelChoiceStore, ModelPicker, Models, modelOptions } from '../models.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { background } from '../observability/background.ts'

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

/**
 * The daily model budget in Credits (ADR 0026) over the agent's usage ledger. The allowance is the plan's, read from
 * the plan the agent keeps (`Entitlements`), so a tool call no longer reads auth D1 each time. Without a plan nothing
 * spends: there is no free plan (ADR 0054, amended 2026-10-13), so every check refuses with `SubscriptionRequired`.
 */
const BudgetLive = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const db = yield* Db
    const ledger = usageLedger(db)
    const plans = yield* Entitlements
    const { env } = yield* AgentInput
    const rates = creditRates(env.MODEL_CREDIT_RATES)
    /** The UTC day (epoch seconds over a day) whose day-pass payment is taken care of or under way, once a day. */
    const paying = yield* Ref.make<number | undefined>(undefined)
    const spent = Effect.fn('Budget.spent')(function* (now: number, limit: number) {
      const { day, resetsAt } = utcDay(now)
      const milli = yield* attemptSync(() => ledger.milliCredits(day))
      return { used: milli / 1000, limit, resetsAt }
    })
    // Without a plan the allowance is none. The plan is read through `require`, whose answer the agent keeps a minute.
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const allowance = yield* plans.require().pipe(
        Effect.map((plan) => plan.dailyCredits),
        Effect.catchTag('SubscriptionRequired', () => Effect.succeed(0)),
      )
      return yield* spent(now, allowance)
    })
    const require = Effect.fn('Budget.require')(function* (now: number) {
      const current = yield* spent(now, (yield* plans.require()).dailyCredits)
      if (current.used >= current.limit)
        return yield* new BudgetExhausted({ limit: current.limit, resetsAt: current.resetsAt })
    })
    /**
     * A day pass's day (ADR 0054): the first admitted message of a UTC day takes its payment in the background, so the
     * answer never waits for it. Only a payment that may go through later (still landing, or the wallet not reached)
     * is tried again with the next message.
     */
    const payToday = Effect.fn('Budget.payToday')(function* (now: number) {
      const day = Math.floor(now / 86_400)
      const claimed = yield* Ref.modify(paying, (current) => [current !== day, day] as const)
      if (!claimed) return
      yield* plans.payDay().pipe(
        Effect.flatMap((outcome) => (outcome === 'retry' ? Ref.set(paying, undefined) : Effect.void)),
        background('billing.payDay'),
      )
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now, model?: string) {
        yield* Effect.sync(() => recordUse(ledger, rates, use, now, model))
      }),
      require,
      open: require,
      admit: Effect.fn('Budget.admit')(function* (now) {
        yield* require(now)
        if ((yield* plans.require()).billing === 'day') yield* payToday(now)
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
 * The daily model budget, over the plan the core layer keeps, and the model picker, over the agent's SQLite (they keep
 * no state of their own). A send's admission reads them, so `layers/index.ts` builds them before the conversation layer.
 */
export const ModelBudgetLive: Layer.Layer<Budget | Models, never, AgentInput | Db | Entitlements> = Layer.mergeAll(
  BudgetLive,
  ModelsLive,
)
