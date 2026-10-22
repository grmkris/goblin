import type { Migration } from './migration.ts'

/**
 * The chat a Persona answers in (its fork), kept on its invocation once it starts: the `subagentRunId` its work streams
 * under in the chat it was asked in (docs/architecture/streams.md). Additive so production keeps its agents; it folds
 * into the baseline at the next reset the owner decides on.
 */
export const INVOCATION_FORK: Migration = {
  key: '20261022200000_invocation_fork',
  tables: ['app_persona_invocations'],
  sql: 'ALTER TABLE app_persona_invocations ADD COLUMN fork TEXT',
}
