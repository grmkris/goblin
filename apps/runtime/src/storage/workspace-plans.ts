import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Application-owned setup proposals. Pi continues to own conversations and execution. */
export const appWorkspacePlans = sqliteTable('app_workspace_plans', {
  id: text('id').primaryKey().notNull(),
  operationId: text('operation_id').notNull().unique(),
  chatId: text('chat_id').notNull(),
  definition: text('definition').notNull(),
  review: text('review').notNull(),
  createdAt: integer('created_at').notNull(),
})
