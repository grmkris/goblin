import { BREAK, type Migration } from './migration.ts'

/**
 * How a Persona's answers reach its MCP tools (ADR 0102), on its current definition and each revision; none is the
 * gateway. Additive so production keeps its agents; it folds into the baseline at the next reset the owner decides on.
 */
export const PERSONA_TOOL_MODE: Migration = {
  key: '20261022150000_persona_tool_mode',
  tables: ['app_personas', 'app_persona_revisions'],
  sql: [
    "ALTER TABLE app_personas ADD COLUMN tool_mode TEXT CHECK (tool_mode IN ('native', 'gateway'))",
    "ALTER TABLE app_persona_revisions ADD COLUMN tool_mode TEXT CHECK (tool_mode IN ('native', 'gateway'))",
  ].join(BREAK),
}
