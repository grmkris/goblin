import type { PersonaFailure } from '@goblin/contracts'
import { safeErrorType } from '../observability/report.ts'
import type { Settlement } from '../personas/invocations.ts'
import { outcomeOf } from '../telemetry/attributes.ts'
import { NO_ANSWER } from './model.ts'

/**
 * Why a turn gave no answer: the reason its invocation keeps (`PersonaFailure`), and the telemetry code its run and its
 * `persona_answer` flow are recorded under (`telemetry/safety.ts`), never its text.
 */
export type Unanswered = { readonly reason: PersonaFailure; readonly code: string }

/** A failed turn's outcome: its message stays in Pi; telemetry reads only its code (`detail.code`). */
export const failed = (message: string, code: string) =>
  ({ status: 'terminal', outcome: { status: 'failed', error: { message, detail: { code } } } }) as const

/** The owner's message the turn answers is not in the chat (it never arrived, or it went unanswered). */
export const ASK_MISSING: Unanswered = { reason: 'unavailable', code: 'ask_missing' }
/** The Persona's fork is gone. */
export const FORK_MISSING: Unanswered = { reason: 'unavailable', code: 'fork_missing' }
/** The answer could not be written back into the chat. */
export const ANSWER_UNWRITTEN: Unanswered = { reason: 'unavailable', code: 'answer_unwritten' }

export const failure = (reason: PersonaFailure): Settlement => ({ state: 'failed', reason })

/**
 * How a Persona's answer flow ended: answered, failed with its code, or stopped by the owner (a refusal of the work).
 */
export const answerFlow = (settlement: Settlement, code: string | undefined) => {
  if (settlement.state === 'answered') return { status: 'ok' } as const
  if (settlement.state === 'stopped') return { status: 'refused', errorType: 'aborted' } as const
  return { status: 'error', errorType: code ?? 'error' } as const
}

/**
 * Why a Persona's fork gave no answer, from how Pi settled its prompt (ADR 0083): its model call failed, or its model
 * gave none, also when goblin's model streams asked it again (`NO_ANSWER`).
 */
export const failureOf = (settled: { readonly status: string; readonly reason?: string; readonly detail?: unknown }) =>
  settled.status === 'unanswered' &&
  (settled.reason === 'model_error' || settled.reason === 'no_model') &&
  settled.detail !== NO_ANSWER
    ? 'model_error'
    : 'no_answer'

/** Why a fork that was asked gave no answer (`failureOf`), with its telemetry code. */
export const unansweredOf = (settled: Parameters<typeof failureOf>[0]): Unanswered => {
  const reason = failureOf(settled)
  return { reason, code: reason === 'model_error' ? 'provider_error' : 'no_answer' }
}

/** The refusals of a turn's admission that stand: anything else is transient, and is tried once more. */
const FINAL_REFUSALS: Readonly<Record<string, PersonaFailure>> = {
  BudgetExhausted: 'budget',
  ResidentInactive: 'unavailable',
  NoModelEndpoint: 'unavailable',
}

/**
 * Why a turn's admission was refused, and whether that stands (`final`): the day's model budget is spent, the owner's
 * authority is not current, or there is no model endpoint. Any other failure is transient, under its telemetry code.
 */
export const refusalOf = (error: unknown): Unanswered & { readonly final: boolean } => {
  const code = safeErrorType(error)
  const reason = FINAL_REFUSALS[code]
  return reason === undefined
    ? { reason: 'unavailable', code: outcomeOf(error), final: false }
    : { reason, code, final: true }
}
