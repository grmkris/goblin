import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The native tool sets Persona forks froze (ADR 0101), one row per distinct set: `id` is the hash of its tools as JSON,
 * so forks that froze the same tools share it, and `tools` the tools themselves (their names, the server and tool each
 * calls, and their cleaned descriptions and schemas).
 */
export const appPersonaToolSets = sqliteTable('app_persona_tool_sets', {
  id: text('id').primaryKey().notNull(),
  tools: text('tools').notNull(),
  createdAt: integer('created_at').notNull(),
})

/** The set each Persona fork answers with, frozen when it was made; a fork without one has no native tools. */
export const appPersonaForkTools = sqliteTable(
  'app_persona_fork_tools',
  {
    chatId: text('chat_id').primaryKey().notNull(),
    setId: text('set_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('app_persona_fork_tools_set').on(table.setId),
    index('app_persona_fork_tools_age').on(table.createdAt),
  ],
)
