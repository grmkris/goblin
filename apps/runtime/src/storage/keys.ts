import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What each server API key made itself (ADR 0081), for display only (ADR 0114: what a key reaches is its grant's): the
 * Topics and Personas, and with them the key's name, which views show (ADR 0108). A row is written only when the key's
 * own create made the resource, never when an operation id found one that was already there. A row made before names
 * were kept has none until the key's next request (`KeyNames`). Looked up by resource too, on every tool call: whether
 * a chat's Topic is a room.
 */
export const appKeyReach = sqliteTable(
  'app_key_reach',
  {
    keyId: text('key_id').notNull(),
    kind: text('kind', { enum: ['topic', 'persona'] }).notNull(),
    resourceId: integer('resource_id').notNull(),
    createdAt: integer('created_at').notNull(),
    keyName: text('key_name'),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.kind, table.resourceId] }),
    index('app_key_reach_resource').on(table.kind, table.resourceId),
  ],
)
