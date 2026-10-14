import { describe, expect, it } from '@effect/vitest'
import type { UsageToday } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Budget, refuseSpent } from '../src/budget.ts'
import { type AppError, BudgetExhausted, Internal } from '../src/http/errors.ts'
import { BUDGET_BLOCKS, budgetVerdict } from '../src/pi/budget.ts'

/** The hook's verdict when today's budget answers `today`, refusing a spent day as the budget does. */
const verdictOf = (today: Effect.Effect<UsageToday, AppError>) => {
  const spent = Effect.flatMap(today, refuseSpent)
  return budgetVerdict.pipe(
    Effect.provideService(
      Budget,
      Budget.of({
        today: () => today,
        record: () => Effect.void,
        require: () => spent,
      }),
    ),
  )
}

const day = (used: number, limit: number): UsageToday => ({ used, limit, resetsAt: 86_400 })

describe('the budget hook before a tool (R1)', () => {
  it.effect('lets a tool run while the day has budget left, and blocks it as spent once it has none', () =>
    Effect.gen(function* () {
      expect(yield* verdictOf(Effect.succeed(day(1, 2)))).toBe('open')
      expect(yield* verdictOf(Effect.succeed(day(2, 2)))).toBe('exhausted')
      expect(yield* verdictOf(Effect.fail(new BudgetExhausted({ limit: 2, resetsAt: 86_400 })))).toBe('exhausted')
    }),
  )

  it.effect('fails closed as a failed check when the ledger cannot be read', () =>
    Effect.gen(function* () {
      expect(yield* verdictOf(Effect.fail(new Internal({ reason: 'usage storage unavailable' })))).toBe('failed')
      expect(yield* verdictOf(Effect.die(new Error('D1_ERROR')))).toBe('failed')
      expect(BUDGET_BLOCKS.failed).not.toContain('used up')
      expect(BUDGET_BLOCKS.exhausted).toContain('used up')
    }),
  )
})
