import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What each server API key made itself (ADR 0081): the Topics and Personas it alone reaches. A row is written only when
 * the key's own create made the resource, never when an operation id found one that was already there.
 */
export const appKeyReach = sqliteTable(
  'app_key_reach',
  {
    keyId: text('key_id').notNull(),
    kind: text('kind', { enum: ['topic', 'persona'] }).notNull(),
    resourceId: integer('resource_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.kind, table.resourceId] })],
)
