import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import { Budget } from '../src/budget.ts'
import { ModelBudgetLive } from '../src/layers/budget.ts'
import { Models } from '../src/models.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** The budget and the model picker over SQLite, as the agent builds them, with the deployment's `cap`. */
const lane = (cap?: string) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  return ModelBudgetLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        sqliteDb(db),
        // SAFETY: the budget and the picker read only the deployment's settings from the instance input.
        Layer.succeed(AgentInput, {
          env: { MODEL_ID: 'model-a', ...(cap === undefined ? {} : { DAILY_TOKEN_CAP: cap }) },
        } as AgentInputs),
      ),
    ),
  )
}

const NOW = 86_400 * 20_000 + 60
const TOKENS = { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('the model usage the agent checks', () => {
  it.effect("counts today's tokens against the deployment's cap and refuses once it is reached", () =>
    Effect.gen(function* () {
      const budget = yield* Budget
      yield* budget.record(TOKENS, NOW)
      expect(yield* budget.today(NOW)).toEqual({ used: 5000, limit: 8000, resetsAt: 86_400 * 20_001 })
      yield* budget.require(NOW)
      yield* budget.record(TOKENS, NOW)
      expect(yield* Effect.flip(budget.require(NOW))).toMatchObject({ _tag: 'BudgetExhausted', limit: 8000 })
      expect(yield* budget.today(NOW + 86_400)).toMatchObject({ used: 0 })
    }).pipe(Effect.provide(lane('8000'))),
  )

  it.effect('refuses nothing without a cap', () =>
    Effect.gen(function* () {
      const budget = yield* Budget
      yield* budget.record({ ...TOKENS, input: 50_000_000 }, NOW)
      expect(yield* budget.today(NOW)).toMatchObject({ used: 50_000_000, limit: null })
      yield* budget.require(NOW)
    }).pipe(Effect.provide(lane())),
  )

  it.effect("offers the deployment's models", () =>
    Effect.gen(function* () {
      const choice = yield* Models.use((models) => models.choice).pipe(Effect.provide(lane()))
      expect(choice.options.map((option) => option.id)).toEqual(['model-a'])
    }),
  )
})
