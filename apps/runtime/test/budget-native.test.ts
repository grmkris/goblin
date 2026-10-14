import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import type { EntitlementPolicy } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { ModelBudgetLive } from '../src/layers/budget.ts'
import { EntitlementsLive } from '../src/layers/core.ts'
import { Models } from '../src/models.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'

const PLAN: AccountPlan = {
  active: true,
  plan: 'pro',
  source: 'override',
  billing: null,
  until: null,
  dailyCredits: 2,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** The lane's layer over SQLite, with an account plan whose reads (auth D1) are counted. */
const lane = (options: { readonly plan?: AccountPlan } = {}) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  let reads = 0
  let days = 0
  const state = Effect.sync(() => {
    reads += 1
    return options.plan ?? PLAN
  })
  const plans: EntitlementPolicy = {
    state: () => state,
    require: () => state,
    payDay: () =>
      Effect.sync(() => {
        days += 1
        return 'settled' as const
      }),
  }
  const layer = ModelBudgetLive.pipe(
    Layer.provideMerge(EntitlementsLive),
    Layer.provide(
      Layer.mergeAll(
        sqliteDb(db),
        // SAFETY: the budget, the kept plan and the picker read only these from the instance input.
        Layer.succeed(AgentInput, { entitlements: plans, env: { MODEL_ID: 'model-a' } } as AgentInputs),
      ),
    ),
  )
  return { layer, reads: () => reads, days: () => days, db }
}

const NOW = 86_400 * 20_000 + 60
describe('the model budget the agent checks (R5)', () => {
  it.effect(
    'refuses a turn, a tool and routine work without a plan as `chat`, and shows no allowance (ADR 0054)',
    () => {
      const none: AccountPlan = { ...PLAN, active: false, plan: null, source: 'none', dailyCredits: 0 }
      const { layer, days } = lane({ plan: none })
      return Effect.gen(function* () {
        const budget = yield* Budget
        for (const check of [budget.admit(NOW), budget.open(NOW), budget.require(NOW)])
          expect(yield* Effect.flip(check)).toMatchObject({ _tag: 'SubscriptionRequired', feature: 'chat' })
        expect(yield* budget.today(NOW)).toMatchObject({ used: 0, limit: 0 })
        expect(days()).toBe(0)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "pays a day pass's day on the first turn of a UTC day, once, and never on a tool's check (ADR 0054)",
    () => {
      const { layer, days } = lane({ plan: { ...PLAN, source: 'wallet', billing: 'day' } })
      return Effect.gen(function* () {
        const budget = yield* Budget
        yield* budget.open(NOW)
        yield* Effect.yieldNow
        expect(days()).toBe(0)
        yield* budget.admit(NOW)
        yield* budget.admit(NOW + 3600)
        yield* Effect.yieldNow
        expect(days()).toBe(1)
        yield* budget.admit(NOW + 86_400)
        yield* Effect.yieldNow
        expect(days()).toBe(2)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('never pays a day on monthly or an override', () => {
    const { layer, days } = lane({ plan: { ...PLAN, source: 'wallet', billing: 'month' } })
    return Effect.gen(function* () {
      yield* Budget.use((budget) => budget.admit(NOW))
      yield* Effect.yieldNow
      expect(days()).toBe(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("counts today's spend against the plan's allowance, reading the plan once a minute", () => {
    const { layer, reads } = lane()
    return Effect.gen(function* () {
      const budget = yield* Budget
      const now = 86_400 * 20_000 + 60
      yield* budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, now)
      expect(yield* budget.today(now)).toEqual({ used: 1, limit: 2, resetsAt: 86_400 * 20_001 })
      yield* budget.require(now)
      yield* budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, now, 'model-a')
      expect(yield* Effect.flip(budget.require(now))).toMatchObject({ _tag: 'BudgetExhausted', limit: 2 })
      expect(reads()).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("offers the deployment's models", () =>
    Effect.gen(function* () {
      const choice = yield* Models.use((models) => models.choice).pipe(Effect.provide(lane().layer))
      expect(choice.options.map((option) => option.id)).toEqual(['model-a'])
    }),
  )
})
