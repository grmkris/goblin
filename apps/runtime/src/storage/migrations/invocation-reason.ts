import type { Migration } from './migration.ts'

/**
 * Why a failed Persona invocation gave no answer (ADR 0083). Additive so production keeps its agents; it folds into the
 * baseline at the next reset the owner decides on.
 */
export const INVOCATION_REASON: Migration = {
  key: '20261020120000_invocation_reason',
  tables: ['app_persona_invocations'],
  sql: "ALTER TABLE app_persona_invocations ADD COLUMN reason TEXT CHECK (reason IN ('no_answer', 'model_error', 'budget', 'unavailable'))",
}
