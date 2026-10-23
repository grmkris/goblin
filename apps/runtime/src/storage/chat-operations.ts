import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What happens in a chat by operation (ADR 0030). Pi deduplicates per session; a chat's admission remembers the session
 * an operation was first admitted to, so a replay keeps it. The receipt says what the operation was, who started it,
 * what it led to and how it ended; every admission writes it. `role` is the role of the member whose request admitted
 * it (ADR 0099), none for work no member sent. `power` is what its sender may do in a turn it starts or joins (ADR
 * 0115, `grants/power.ts`), as JSON; none for work no person or credential sent.
 */
export const appChatOperations = sqliteTable(
  'app_chat_operations',
  {
    chatId: text('chat_id').notNull(),
    operationId: text('operation_id').notNull(),
    sessionId: text('session_id').notNull(),
    admittedAt: integer('admitted_at').notNull(),
    kind: text('kind'),
    origin: text('origin'),
    role: text('role'),
    power: text('power'),
    targetChat: text('target_chat'),
    parentOp: text('parent_op'),
    state: text('state'),
    reason: text('reason'),
    settledAt: integer('settled_at'),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.operationId] })],
)
