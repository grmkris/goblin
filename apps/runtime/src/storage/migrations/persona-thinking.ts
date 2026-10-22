import { BREAK, type Migration } from './migration.ts'

/**
 * How hard a Persona's model thinks (ADR 0100), on its current definition and each revision. Additive so production
 * keeps its agents; it folds into the baseline at the next reset the owner decides on.
 */
export const PERSONA_THINKING: Migration = {
  key: '20261022120000_persona_thinking',
  tables: ['app_personas', 'app_persona_revisions'],
  sql: [
    "ALTER TABLE app_personas ADD COLUMN thinking TEXT CHECK (thinking IN ('low', 'medium', 'high'))",
    "ALTER TABLE app_persona_revisions ADD COLUMN thinking TEXT CHECK (thinking IN ('low', 'medium', 'high'))",
  ].join(BREAK),
}
