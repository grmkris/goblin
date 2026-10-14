import { BREAK, type Migration } from './migration.ts'

/**
 * Telegram chats routed to Topics (ADR 0055, keys from `20261031005400_`): the routes and the messages held for a
 * route, what goblin does with new chats and how far the grant reaches, and where each answer goes back; the doorbell's
 * row goes. Added by its own migration, so dev and prod keep their data.
 */
export const TELEGRAM_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261031005400_telegram_routes',
    tables: ['app_telegram_routes', 'app_telegram_held', 'app_telegram_channel', 'app_channel_replies', 'app_channel'],
    sql: [
      `CREATE TABLE app_telegram_routes (chat TEXT NOT NULL, thread INTEGER NOT NULL CHECK (thread >= 0), title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('private', 'group', 'supergroup')), is_forum INTEGER, status TEXT NOT NULL CHECK (status IN ('pending', 'routed', 'paused', 'left')), mode TEXT CHECK (mode IN ('answer', 'listen', 'ignore')), topic_id INTEGER, persona_id INTEGER, question_id TEXT, offer TEXT CHECK (offer IN ('open', 'closed')), held_dropped INTEGER NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, updated_by TEXT CHECK (updated_by IN ('owner', 'agent')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (chat, thread), CHECK ((mode IN ('answer', 'listen')) = (topic_id IS NOT NULL)), CHECK (persona_id IS NULL OR mode = 'answer'))`,
      'CREATE UNIQUE INDEX app_telegram_routes_question ON app_telegram_routes (question_id) WHERE question_id IS NOT NULL',
      'CREATE TABLE app_telegram_held (entry_id TEXT PRIMARY KEY NOT NULL, chat TEXT NOT NULL, thread INTEGER NOT NULL, text TEXT NOT NULL, trigger TEXT, held_at INTEGER NOT NULL)',
      'CREATE INDEX app_telegram_held_chat ON app_telegram_held (chat, held_at)',
      `ALTER TABLE app_telegram_channel ADD COLUMN new_chats TEXT NOT NULL DEFAULT 'ask' CHECK (new_chats IN ('ask', 'topic', 'personal'))`,
      `ALTER TABLE app_telegram_channel ADD COLUMN reach TEXT NOT NULL DEFAULT 'dm' CHECK (reach IN ('dm', 'all'))`,
      'ALTER TABLE app_telegram_channel ADD COLUMN widen_url TEXT',
      'ALTER TABLE app_telegram_channel ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE app_telegram_channel ADD COLUMN sync_due INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE app_telegram_channel ADD COLUMN ended INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE app_channel_replies ADD COLUMN chat_id TEXT',
      `ALTER TABLE app_channel_replies ADD COLUMN tg_chat TEXT NOT NULL DEFAULT 'dm'`,
      'ALTER TABLE app_channel_replies ADD COLUMN tg_thread INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE app_channel_replies ADD COLUMN persona_id INTEGER',
      'ALTER TABLE app_channel_replies ADD COLUMN ask_question TEXT',
      'ALTER TABLE app_channel_replies ADD COLUMN ask_options TEXT',
      'CREATE INDEX app_channel_replies_ask ON app_channel_replies (ask_question) WHERE ask_question IS NOT NULL',
      // The doorbell is gone with mygram's (ADR 0055): only Events carry the channel.
      'DROP TABLE app_channel',
    ].join(BREAK),
  },
]
