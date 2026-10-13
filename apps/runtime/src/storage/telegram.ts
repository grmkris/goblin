import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Where each Telegram chat and forum topic goes (ADR 0055), by mygram's chat handle and its thread (0 is the chat
 * itself). `status` is `pending` until the owner chooses, `routed` after, and `paused` / `left` while the bot is out
 * of the chat. A row's own route is `mode` (`answer` and `listen` with a Topic, `answer` with an optional Persona);
 * none while it is pending, or for a topic that follows its chat. `question_id` is goblin's question about it in the
 * DM, asked once: `offer` is `open` until it is answered (there or by any route choice), then `closed`. `held_dropped` counts the held messages dropped past the twenty kept. `revision`
 * counts route changes, so Undo can tell whether anything touched it. Times are epoch seconds.
 */
export const appTelegramRoutes = sqliteTable(
  'app_telegram_routes',
  {
    chat: text('chat').notNull(),
    thread: integer('thread').notNull(),
    title: text('title').notNull(),
    kind: text('kind', { enum: ['private', 'group', 'supergroup'] }).notNull(),
    isForum: integer('is_forum', { mode: 'boolean' }),
    status: text('status', { enum: ['pending', 'routed', 'paused', 'left'] }).notNull(),
    mode: text('mode', { enum: ['answer', 'listen', 'ignore'] }),
    topicId: integer('topic_id'),
    personaId: integer('persona_id'),
    questionId: text('question_id'),
    offer: text('offer', { enum: ['open', 'closed'] }),
    heldDropped: integer('held_dropped').notNull().default(0),
    listed: integer('listed', { mode: 'boolean' }).notNull().default(true),
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by', { enum: ['owner', 'agent'] }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chat, table.thread] })],
)

/**
 * Messages of a chat that waits for the owner's route (ADR 0055), at most twenty a chat, delivered in order once it
 * has one: mygram's entry id, where it came from, its words (text and attachment lines) and how it reached the bot.
 */
export const appTelegramHeld = sqliteTable(
  'app_telegram_held',
  {
    entryId: text('entry_id').primaryKey().notNull(),
    chat: text('chat').notNull(),
    thread: integer('thread').notNull(),
    text: text('text').notNull(),
    trigger: text('trigger'),
    heldAt: integer('held_at').notNull(),
  },
  (table) => [index('app_telegram_held_chat').on(table.chat, table.heldAt)],
)
