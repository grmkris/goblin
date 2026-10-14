import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The owner's own model endpoint (ADR 0059), one row: its OpenAI-compatible base URL, its key sealed with the
 * credential cipher, the model ids it listed when it was set (a JSON array), and the one goblin answers with by default.
 * No row: the deployment's endpoint answers. Times are epoch seconds.
 */
export const appModelEndpoint = sqliteTable('app_model_endpoint', {
  id: integer('id').primaryKey(),
  baseUrl: text('base_url').notNull(),
  keySealed: text('key_sealed').notNull(),
  models: text('models').notNull(),
  model: text('model').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
