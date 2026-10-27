import { GenerationTask, ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { Budget } from '../budget.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { epochSeconds } from '../clock.ts'
import { type CallApi, turnPower } from './asker.ts'
import type { PiContext } from './context.ts'

/** Why a tool may not run against today's budget, or `open` when it may. */
export type BudgetVerdict = 'open' | 'exhausted' | 'unconfigured' | 'failed'

/**
 * What the model is told when a tool is blocked: only a spent budget reads as spent. A spent budget stops the work and
 * nothing resumes it, so the text says so and never invites a promise to carry on later: a person's turn may hear when
 * the budget resets, to send again then; an installed app's turn (`server`) is told no reset at all, since no one sends
 * it again on its own (`exhaustedBlock`).
 */
export const BUDGET_BLOCKS: Readonly<Record<Exclude<BudgetVerdict, 'open'>, string>> = {
  exhausted:
    "Today's model budget is used up, so this stopped. Nothing resumes on its own; the budget resets at 00:00 UTC, when they can send again.",
  unconfigured:
    'No model endpoint is set any more, so this tool was not run. Tell the user to bring their own model key in Settings.',
  failed: "Today's model budget could not be checked, so this tool was not run. Tell the user, then try again later.",
}

/** A spent budget's block for an installed app's turn: stopped, and no reset to wait for. */
export const SERVER_EXHAUSTED = "Today's model budget is used up, so this stopped. Nothing resumes on its own."

/** The block for `verdict` on a turn an installed app sent (`server`) or not. */
export const blockFor = (verdict: Exclude<BudgetVerdict, 'open'>, server: boolean): string =>
  verdict === 'exhausted' && server ? SERVER_EXHAUSTED : BUDGET_BLOCKS[verdict]

/**
 * Today's budget as a tool sees it: spent (`BudgetExhausted` or used up), no endpoint left to call (`NoModelEndpoint`,
 * the owner took theirs away mid-turn), or open. Anything else (the ledger failing) is reported and fails closed as a
 * check that failed, never as a spent budget.
 */
export const budgetVerdict: Effect.Effect<BudgetVerdict, never, Budget> = Effect.gen(function* () {
  const budget = yield* Budget
  yield* budget.require(yield* epochSeconds)
  return 'open' as const
}).pipe(
  Effect.catchTags({
    BudgetExhausted: () => Effect.succeed('exhausted' as const),
    NoModelEndpoint: () => Effect.succeed('unconfigured' as const),
  }),
  reportAndRecover('budget.beforeTool', 'failed' as const),
)

/**
 * Whether an installed app sent the turn the call `api` serves. It only changes a spent budget's words, so a turn whose
 * senders cannot be read is reported and told what an app is: no reset.
 */
const sentByApp = (api: CallApi, context: PiContext) =>
  Effect.map(turnPower(api, context), (power) => power.server).pipe(reportAndRecover('budget.sender', true))

/** The sender check could not run at all: reported, and the turn is told no reset. */
const reportUnreadSender = (error: unknown): boolean => {
  writeLine('error', { event: 'failure', where: 'budget.sender', 'error.type': safeErrorType(error) })
  return true
}

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
export function budgetExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.budget',
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message) => {
          await run(
            Effect.gen(function* () {
              const budget = yield* Budget
              yield* budget.record(message.usage, yield* epochSeconds)
            }),
          )
        },
      }),
      hook(ToolTask, {
        beforeTool: async (_call, api, context) => {
          const verdict = await run(budgetVerdict).catch(reportUnchecked)
          if (verdict === 'open') return undefined
          const server = verdict === 'exhausted' && (await run(sentByApp(api, context)).catch(reportUnreadSender))
          return { block: blockFor(verdict, server) }
        },
      }),
    ],
  })
}
