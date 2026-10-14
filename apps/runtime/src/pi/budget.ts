import { GenerationTask, ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { Budget } from '../budget.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { epochSeconds } from '../clock.ts'

/** Why a tool may not run against today's budget, or `open` when it may. */
export type BudgetVerdict = 'open' | 'exhausted' | 'failed'

/** What the model is told when a tool is blocked: only a spent budget reads as spent. */
export const BUDGET_BLOCKS: Readonly<Record<Exclude<BudgetVerdict, 'open'>, string>> = {
  exhausted:
    "Today's model budget is used up, so this tool was not run. Tell the user, and that the budget resets at 00:00 UTC.",
  failed: "Today's model budget could not be checked, so this tool was not run. Tell the user, then try again later.",
}

/**
 * Today's budget as a tool sees it: spent (`BudgetExhausted` or used up), or open. Anything else (the ledger failing) is
 * reported and fails closed as a check that failed, never as a spent budget.
 */
export const budgetVerdict: Effect.Effect<BudgetVerdict, never, Budget> = Effect.gen(function* () {
  const budget = yield* Budget
  yield* budget.require(yield* epochSeconds)
  return 'open' as const
}).pipe(
  Effect.catchTag('BudgetExhausted', () => Effect.succeed('exhausted' as const)),
  reportAndRecover('budget.beforeTool', 'failed' as const),
)

/** The check could not run at all (the agent's runtime did not start): the tool is blocked as a failed check. */
const reportUnchecked = (error: unknown): BudgetVerdict => {
  writeLine('error', { event: 'failure', where: 'budget.beforeTool', 'error.type': safeErrorType(error) })
  return 'failed'
}

/**
 * The user's daily model usage inside a turn. Every response's tokens are recorded; once a capped day is spent, tool
 * calls are blocked, so a turn looping through tools ends after one more reply. New turns are refused at submission
 * (agent.ts). Pi reports and swallows hook exceptions, so blocking a tool is the lever, not throwing.
 */
export function budgetExtension(local: RunProgram) {
  return defineExtension({
    name: 'goblin.budget',
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message) => {
          await local(
            Effect.gen(function* () {
              const budget = yield* Budget
              yield* budget.record(message.usage, yield* epochSeconds)
            }),
          )
        },
      }),
      hook(ToolTask, {
        beforeTool: async () => {
          const verdict = await local(budgetVerdict).catch(reportUnchecked)
          return verdict === 'open' ? undefined : { block: BUDGET_BLOCKS[verdict] }
        },
      }),
    ],
  })
}
