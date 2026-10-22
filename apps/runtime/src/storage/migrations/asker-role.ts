import type { Migration } from './migration.ts'

/**
 * Who asked, by role (ADR 0099): the role of the member whose request admitted an operation, so a tool can tell that the
 * run it serves took a member's input. Additive so production keeps its agents; it folds into the baseline at the next
 * reset the owner decides on.
 */
export const ASKER_ROLE: Migration = {
  key: '20261022160000_asker_role',
  tables: ['app_chat_operations'],
  sql: "ALTER TABLE app_chat_operations ADD COLUMN role TEXT CHECK (role IN ('owner', 'admin', 'member'))",
}
