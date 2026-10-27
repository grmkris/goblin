import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What each server made itself, for display only (ADRs 0114, 0115): the Topics and Personas an installed app made (ADR
 * 0118), and before ADR 0125 a key, with the server's name, which views show and the sidebar groups by.
 * Nothing a credential may reach or a turn may do depends on it. A row is written only when the server's own create
 * made the resource, never when an operation id found one that was already there; one a key made before names were kept
 * has its id alone. The columns keep their first names (`key_id`, `key_name`). Views read it by resource.
 */
export const appMadeBy = sqliteTable(
  'app_made_by',
  {
    makerId: text('key_id').notNull(),
    kind: text('kind', { enum: ['topic', 'persona'] }).notNull(),
    resourceId: integer('resource_id').notNull(),
    createdAt: integer('created_at').notNull(),
    makerName: text('key_name'),
  },
  (table) => [
    primaryKey({ columns: [table.makerId, table.kind, table.resourceId] }),
    index('app_made_by_resource').on(table.kind, table.resourceId),
  ],
)
