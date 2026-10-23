import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The agent's mirror of the credentials' grants that reach it (ADR 0114): for each grant, whether its Topics, Personas
 * and connections here are all or a list, the generation of the auth store's row it was read at and when, and the
 * listed ids. `Grants.sync` reads it again from the auth D1 when a request forwards another generation; every reach
 * check joins it, so a list of any length is one statement, and the published Events' fan-out checks it with no
 * request at all.
 */
export const appGrantSync = sqliteTable('app_grant_sync', {
  grantId: text('grant_id').primaryKey().notNull(),
  generation: integer('generation').notNull(),
  topics: text('topics', { enum: ['all', 'list'] }).notNull(),
  personas: text('personas', { enum: ['all', 'list'] }).notNull(),
  connections: text('connections', { enum: ['all', 'list'] }).notNull(),
  syncedAt: integer('synced_at').notNull(),
})

/** One listed id of a grant's: `kind` topic, persona or connection; a Topic's or Persona's number in decimal. */
export const appGrantReach = sqliteTable(
  'app_grant_reach',
  {
    grantId: text('grant_id').notNull(),
    kind: text('kind', { enum: ['topic', 'persona', 'connection'] }).notNull(),
    resourceId: text('resource_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.grantId, table.kind, table.resourceId] })],
)
