import { BREAK, type Migration } from './migration.ts'

/**
 * The native tool sets Persona forks freeze, and which fork froze which (ADR 0101). Additive so production keeps its
 * agents; it folds into the baseline at the next reset the owner decides on.
 */
export const PERSONA_TOOLS: Migration = {
  key: '20261022130000_persona_tools',
  tables: ['app_persona_tool_sets', 'app_persona_fork_tools'],
  sql: [
    'CREATE TABLE app_persona_tool_sets (id TEXT PRIMARY KEY NOT NULL, tools TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE TABLE app_persona_fork_tools (chat_id TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX app_persona_fork_tools_set ON app_persona_fork_tools (set_id)',
    'CREATE INDEX app_persona_fork_tools_age ON app_persona_fork_tools (created_at)',
  ].join(BREAK),
}
