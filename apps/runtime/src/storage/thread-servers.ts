import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The MCP servers a server's key declared on one of its threads (ADR 0103): by thread and the name its tools take
 * there, the endpoint and its granted origin, the tools it may call (JSON), its bearer token encrypted with the
 * credential cipher (bound to the workspace, thread, name and endpoint), and the grant of the credential that declared
 * it (ADR 0114), checked again at every use.
 */
export const appThreadServers = sqliteTable(
  'app_thread_servers',
  {
    chatId: text('chat_id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    origin: text('origin').notNull(),
    tools: text('tools').notNull(),
    token: text('token').notNull(),
    grantId: text('grant_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.name] }), index('app_thread_servers_grant').on(table.grantId)],
)

/**
 * Every operation that set a thread's servers, in order (`seq`), with the digest of what it declared, tokens left out:
 * only the newest may change them again, so a late replay of an older one never undoes a later change (ADR 0103).
 */
export const appThreadServerOps = sqliteTable(
  'app_thread_server_ops',
  {
    chatId: text('chat_id').notNull(),
    operationId: text('operation_id').notNull(),
    digest: text('digest').notNull(),
    seq: integer('seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.operationId] })],
)
