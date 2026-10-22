import type { Migration } from './migration.ts'

/**
 * Only the agent proposes a Source (ADR 0068), so a Source no longer keeps who proposed it. A forward migration so
 * production keeps its agents; it folds into the baseline at the next reset the owner decides on.
 */
export const SOURCE_PROPOSER: Migration = {
  key: '20261022000000_source_proposer',
  tables: ['app_source_setups'],
  sql: 'ALTER TABLE app_source_setups DROP COLUMN proposed_by',
}
