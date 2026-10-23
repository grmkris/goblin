import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What each server API key made itself (ADR 0081), for display only (ADRs 0114, 0115): the Topics and Personas, and
 * with them the key's name, which views show and the sidebar groups by. Nothing a credential may reach or a turn may do
 * depends on it. A row is written only when the key's own create made the resource, never when an operation id found
 * one that was already there. A row made before names were kept has none until the key's next request (`KeyNames`).
 * Views read it by resource.
 */
export const appMadeBy = sqliteTable(
  'app_made_by',
  {
    keyId: text('key_id').notNull(),
    kind: text('kind', { enum: ['topic', 'persona'] }).notNull(),
    resourceId: integer('resource_id').notNull(),
    createdAt: integer('created_at').notNull(),
    keyName: text('key_name'),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.kind, table.resourceId] }),
    index('app_made_by_resource').on(table.kind, table.resourceId),
  ],
)
