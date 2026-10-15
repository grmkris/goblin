import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The owner's Sources (ADR 0066): one row each, its setup (`SourceSetup` JSON) at `revision`, proposed by the owner or
 * the agent (`operation_id` makes a proposal idempotent). `state` is `proposed` until the owner confirms that revision
 * (or `refused`), `active` once its event is subscribed, `paused` by the owner or for their review (`paused`), with
 * `health` saying why. A confirmed Source is bound to the connection's endpoint and a digest of its tools' grants
 * (`endpoint`, `grant_version`), and its event is subscribed under consumer `source:<id>` at revision `binding`.
 * `cursor` is where a tool read goes on from; `pull_due` and `resubscribe_due` are the work its alarm owes. Times are
 * epoch seconds.
 */
export const appSourceSetups = sqliteTable('app_source_setups', {
  id: text('id').primaryKey().notNull(),
  operationId: text('operation_id').unique(),
  connectionId: text('connection_id').notNull(),
  title: text('title').notNull(),
  setup: text('setup').notNull(),
  revision: integer('revision').notNull(),
  state: text('state', { enum: ['proposed', 'active', 'paused', 'refused'] }).notNull(),
  paused: text('paused', { enum: ['owner', 'review'] }),
  health: text('health'),
  proposedBy: text('proposed_by', { enum: ['owner', 'agent'] }).notNull(),
  chatId: text('chat_id'),
  endpoint: text('endpoint'),
  grantVersion: text('grant_version'),
  binding: integer('binding'),
  lastBinding: integer('last_binding').notNull().default(0),
  cursor: text('cursor'),
  pullDue: integer('pull_due', { mode: 'boolean' }).notNull().default(false),
  resubscribeDue: integer('resubscribe_due', { mode: 'boolean' }).notNull().default(false),
  confirmedAt: integer('confirmed_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * Where each conversation of a Source goes (ADR 0066), by its key (`key`, the JSON of its values in the setup's order;
 * `key_values` names them) and its `title` (the server's name for it, the newest a message carried). `route` is `topic` or `persona` (turns in `topic_id`, answered by goblin or `persona_id`),
 * `listen` (notes in `topic_id`), `ignore` or `held`. `held_dropped` counts the held messages dropped past the twenty
 * kept; `revision` counts route changes, so Undo can tell whether anything touched it.
 */
export const appSourceRoutes = sqliteTable(
  'app_source_routes',
  {
    sourceId: text('source_id').notNull(),
    key: text('key').notNull(),
    keyValues: text('key_values').notNull(),
    title: text('title'),
    route: text('route', { enum: ['topic', 'persona', 'listen', 'ignore', 'held'] }).notNull(),
    topicId: integer('topic_id'),
    personaId: integer('persona_id'),
    heldDropped: integer('held_dropped').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by', { enum: ['owner', 'agent', 'default'] }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.key] })],
)

/**
 * The owner's messages a conversation holds while it waits for a route (ADR 0066), at most twenty a conversation,
 * delivered in order once it has one: the message's id, its conversation, its words, and the files goblin kept of its
 * attachments (`files`, JSON: their references and notes; ADR 0065).
 */
export const appSourceHeld = sqliteTable(
  'app_source_held',
  {
    sourceId: text('source_id').notNull(),
    itemId: text('item_id').notNull(),
    key: text('key').notNull(),
    text: text('text').notNull(),
    files: text('files'),
    heldAt: integer('held_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.itemId] }),
    index('app_source_held_key').on(table.sourceId, table.key),
  ],
)

/**
 * The answers a Source owes (ADR 0066): the turn's operation, its conversation, the goblin chat it ran in and the
 * Persona that answers it. Frozen calls acknowledge each piece; only explicit retryable results get another attempt.
 * Terminal rows remain due until their idempotent report and owner notice are recorded.
 */
export const appSourceReplies = sqliteTable(
  'app_source_replies',
  {
    operationId: text('operation_id').primaryKey().notNull(),
    sourceId: text('source_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceBinding: integer('source_binding'),
    key: text('key').notNull(),
    chatId: text('chat_id'),
    personaId: integer('persona_id'),
    plan: text('plan'),
    nextPiece: integer('next_piece').notNull().default(0),
    dispatching: integer('dispatching', { mode: 'boolean' }).notNull().default(false),
    reported: integer('reported', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    nextAt: integer('next_at').notNull().default(0),
    outcome: text('outcome', { enum: ['accepted', 'rejected', 'unknown', 'given_up'] }),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (table) => [index('app_source_replies_due').on(table.reported, table.nextAt)],
)

/**
 * "Notify me via" (ADR 0066): the one row of the owner's choice of a connection's tool and its arguments template
 * (JSON, `{{text}}` and `{{operationId}}` as whole values) that copies goblin's notices to them; set at `updated_at`
 * (epoch seconds).
 */
export const appNotifySink = sqliteTable('app_notify_sink', {
  id: integer('id').primaryKey().notNull(),
  connectionId: text('connection_id').notNull(),
  tool: text('tool').notNull(),
  arguments: text('arguments').notNull(),
  policy: text('policy').notNull().default('{}'),
  revision: text('revision').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
})
