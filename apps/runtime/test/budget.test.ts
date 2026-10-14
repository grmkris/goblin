import { describe, expect, it } from 'vitest'
import { ModelBudget, type UsageLedger, dailyTokenCap, utcDay } from '../src/budget.ts'
import type { TokenUse } from '../src/token-use.ts'

class MemoryLedger implements UsageLedger {
  readonly days = new Map<string, number>()
  tokens(day: string): number {
    return this.days.get(day) ?? 0
  }
  add(day: string, tokens: number): void {
    this.days.set(day, (this.days.get(day) ?? 0) + tokens)
  }
}

const use = (input: number, output = 0, cacheRead = 0): TokenUse => ({ input, output, cacheRead, cacheWrite: 0 })

// 2026-10-04T23:59:30Z and 40 seconds later, across UTC midnight.
const BEFORE_MIDNIGHT = 1_791_158_370
const AFTER_MIDNIGHT = BEFORE_MIDNIGHT + 40

describe('per-account model usage (unit)', () => {
  it('keys usage by UTC day and resets at midnight', () => {
    expect(utcDay(BEFORE_MIDNIGHT)).toEqual({ day: '2026-10-04', resetsAt: 1_791_158_400 })
    expect(utcDay(AFTER_MIDNIGHT).day).toBe('2026-10-05')
  })

  it('counts every token, refuses once a capped day is spent, and allows again the next day', async () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 6000)
    budget.record(use(5000), BEFORE_MIDNIGHT)
    await expect(budget.require(BEFORE_MIDNIGHT)).resolves.toBeUndefined()
    budget.record(use(0, 830, 170), BEFORE_MIDNIGHT)
    expect(await budget.today(BEFORE_MIDNIGHT)).toEqual({ used: 6000, limit: 6000, resetsAt: 1_791_158_400 })
    await expect(budget.require(BEFORE_MIDNIGHT)).rejects.toMatchObject({
      _tag: 'BudgetExhausted',
      limit: 6000,
      resetsAt: 1_791_158_400,
    })
    await expect(budget.require(AFTER_MIDNIGHT)).resolves.toBeUndefined()
  })

  it('never refuses without a cap', async () => {
    const budget = new ModelBudget(new MemoryLedger(), null)
    budget.record(use(10_000_000), BEFORE_MIDNIGHT)
    expect(await budget.today(BEFORE_MIDNIGHT)).toMatchObject({ used: 10_000_000, limit: null })
    await expect(budget.require(BEFORE_MIDNIGHT)).resolves.toBeUndefined()
  })

  it('ignores responses that report no usage', () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 10)
    budget.record(use(0), BEFORE_MIDNIGHT)
    budget.record(use(Number.NaN), BEFORE_MIDNIGHT)
    budget.record(use(-5), BEFORE_MIDNIGHT)
    expect(ledger.days.size).toBe(0)
  })

  it('reads the deployment cap as a positive whole number, else none', () => {
    expect(dailyTokenCap('2000000')).toBe(2_000_000)
    for (const value of [undefined, '', ' ', '0', '-5', '1.5', 'many']) expect(dailyTokenCap(value)).toBeNull()
  })
})
