import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// The MCP Events goblin publishes (ADR 0112, docs/architecture/published-events.md): the journal of occurrences with
// its position, the chats waiting to be looked at, the leases integrators hold and the deliveries owed to them.

/**
 * The journal's one position row (`id` 1), as mysi's `owner_seq` keeps one per owner: `head` is the newest occurrence's
 * sequence number, `floor` the newest one pruned (a cursor below it missed some), and `polledAt` when anyone last
 * polled (epoch ms): with no lease and no poll for the journal's retention, nothing is journaled.
 */
export const appPublishPosition = sqliteTable('app_publish_position', {
  id: integer('id').primaryKey(),
  head: integer('head').notNull().default(0),
  floor: integer('floor').notNull().default(0),
  polledAt: integer('polled_at'),
})

/**
 * Every occurrence, by its sequence number (the cursor a poll and a gap carry): its event id (a webhook's `webhook-id`),
 * the event's name, the chat and its Topic, its data as sent (JSON) and when (epoch ms). Kept seven days.
 */
export const appPublishJournal = sqliteTable(
  'app_publish_journal',
  {
    seq: integer('seq').primaryKey(),
    eventId: text('event_id').notNull().unique(),
    name: text('name').notNull(),
    chatId: text('chat_id').notNull(),
    topicId: integer('topic_id').notNull(),
    dataJson: text('data_json').notNull(),
    at: integer('at').notNull(),
  },
  (table) => [index('app_publish_journal_chat').on(table.chatId, table.seq)],
)

/** The chats a change touched that were not looked at yet, since when (epoch ms): looked at again after a restart. */
export const appPublishDirty = sqliteTable('app_publish_dirty', {
  chatId: text('chat_id').primaryKey(),
  since: integer('since').notNull(),
})

/**
 * A lease on webhook deliveries (ADR 0112). Its id is the hash of its holder (`key:<id>`, `client:<id>:<user>` or
 * `member:<user>`), selector and exact URL, so subscribing again finds it. The selector's arguments as canonical JSON,
 * and the Topic or chat they name; the secret sealed with the credential cipher; `refreshBefore` when it ends unless
 * renewed (epoch ms). `failing` once a delivery was given up on (a gap went out), `terminated` once it ended.
 */
export const appPublishSubscriptions = sqliteTable(
  'app_publish_subscriptions',
  {
    id: text('id').primaryKey(),
    principal: text('principal').notNull(),
    name: text('name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    topicId: integer('topic_id'),
    chatId: text('chat_id'),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    refreshBefore: integer('refresh_before').notNull(),
    status: text('status', { enum: ['active', 'failing', 'terminated'] }).notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('app_publish_subscriptions_principal').on(table.principal)],
)

/**
 * A delivery owed to a lease: an occurrence's wake for one chat (at most one waiting per lease and chat, since each says
 * only that the chat changed), or a control (`gap`, `terminated`). `body` is the exact JSON sent, `webhookId` its
 * `webhook-id`. `attempts` so far, the first one's time, when the next is due (epoch ms), and the claim of the drain
 * sending it now, with when that claim lapses.
 */
export const appPublishDeliveries = sqliteTable(
  'app_publish_deliveries',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    subscriptionId: text('subscription_id').notNull(),
    kind: text('kind', { enum: ['occurrence', 'gap', 'terminated'] }).notNull(),
    chatId: text('chat_id'),
    journalSeq: integer('journal_seq'),
    webhookId: text('webhook_id').notNull(),
    body: text('body').notNull(),
    attempts: integer('attempts').notNull().default(0),
    firstAt: integer('first_at').notNull(),
    nextAt: integer('next_at').notNull(),
    claim: text('claim'),
    claimedUntil: integer('claimed_until'),
  },
  (table) => [
    index('app_publish_deliveries_due').on(table.nextAt),
    uniqueIndex('app_publish_deliveries_waiting')
      .on(table.subscriptionId, table.chatId)
      .where(sql`${table.kind} = 'occurrence' AND ${table.claim} IS NULL`),
  ],
)
