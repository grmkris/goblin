import type { UsageToday } from '@goblin/contracts'
import { eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type AppError, BudgetExhausted } from './http/errors.ts'
import { appUsageDaily } from './storage/schema.ts'
import { epochSeconds } from './clock.ts'
import { type TokenUse, totalTokens } from './token-use.ts'

const DAY_SECONDS = 86_400

/** The UTC day containing `now` (seconds) as `YYYY-MM-DD`, and when it ends. */
export const utcDay = (now: number): { readonly day: string; readonly resetsAt: number } => {
  const start = now - (now % DAY_SECONDS)
  return { day: new Date(start * 1000).toISOString().slice(0, 10), resetsAt: start + DAY_SECONDS }
}

/** What the agent spent per UTC day, in tokens. */
export interface UsageLedger {
  tokens(day: string): number
  add(day: string, tokens: number, now: number): void
}

/** Tokens the agent spent on `day`. */
export const usageTokens = (db: DrizzleSqliteDODatabase, day: string): number =>
  db.select().from(appUsageDaily).where(eq(appUsageDaily.day, day)).get()?.tokens ?? 0

/** Adds one response's tokens to `day`. */
export const addUsage = (db: DrizzleSqliteDODatabase, day: string, tokens: number, now: number): void => {
  db.insert(appUsageDaily)
    .values({ day, tokens, updatedAt: now })
    .onConflictDoUpdate({
      target: appUsageDaily.day,
      set: { tokens: sql`${appUsageDaily.tokens} + ${tokens}`, updatedAt: now },
    })
    .run()
}

/** The agent's usage ledger: the daily table in its database. */
export const usageLedger = (db: DrizzleSqliteDODatabase): UsageLedger => ({
  tokens: (day) => usageTokens(db, day),
  add: (day, tokens, now) => addUsage(db, day, tokens, now),
})

/** Counts one model response's tokens in `ledger`. */
export function recordUse(ledger: UsageLedger, use: TokenUse, now: number): void {
  const tokens = totalTokens(use)
  if (!Number.isFinite(tokens) || tokens <= 0) return
  ledger.add(utcDay(now).day, tokens, now)
}

/**
 * The deployment's daily token cap per account (`DAILY_TOKEN_CAP`, a positive whole number), or none. Accounts that
 * share the deployment's model key are each capped, so no one account can spend it for everyone.
 */
export const dailyTokenCap = (value: string | undefined): number | null => {
  const cap = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isSafeInteger(cap) && cap > 0 ? cap : null
}

/** Today's spend against `cap`: `BudgetExhausted` once a cap is set and reached. */
export const refuseSpent = (today: UsageToday): Effect.Effect<void, BudgetExhausted> =>
  today.limit !== null && today.used >= today.limit
    ? Effect.fail(new BudgetExhausted({ limit: today.limit, resetsAt: today.resetsAt }))
    : Effect.void

/** The agent's daily model usage and cap, as the programs use it. Instants are epoch seconds. */
export class Budget extends Context.Service<
  Budget,
  {
    /** Today's tokens and the deployment's cap, null when there is none. */
    readonly today: (now: number) => Effect.Effect<UsageToday, AppError>
    /** One model response's tokens. */
    readonly record: (use: TokenUse, now: number) => Effect.Effect<void>
    /**
     * `NoModelEndpoint` while there is no model endpoint to call (ADR 0064), `BudgetExhausted` once a cap is set and
     * today's tokens have reached it. Every model call goblin makes asks this.
     */
    readonly require: (now: number) => Effect.Effect<void, AppError>
  }
>()('goblin/budget/Budget') {}

/** `BudgetExhausted` once the agent has spent today's capped tokens; `NoModelEndpoint` while it has no endpoint. */
export const requireBudget: Effect.Effect<void, AppError, Budget> = Effect.flatMap(epochSeconds, (now) =>
  Budget.use((budget) => budget.require(now)),
)
