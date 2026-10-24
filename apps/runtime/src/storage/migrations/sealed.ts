import { BREAK, type Migration } from './migration.ts'

/**
 * Every Topic is sealed (ADR 0115): how far each Topic's chats reach (`sealed`, and Personal, id 1, the hub), which
 * replaces the search opt-out; which installed app wrote a Topic's guidance (`guidance_by`, none for a person's; the
 * guidance a room had is its key's, as its chats read it until now); what each operation's sender may do in a turn
 * (`power`, none on the receipts made before, which read by their origin); and what a key made kept for display only,
 * as `app_made_by`. Forward, so production keeps its agents.
 */
export const SEALED: Migration = {
  key: '20261024000000_sealed',
  tables: ['app_topics', 'app_chat_operations', 'app_key_reach', 'app_made_by'],
  sql: [
    "ALTER TABLE app_topics ADD COLUMN reach TEXT NOT NULL DEFAULT 'sealed' CHECK (reach IN ('sealed', 'hub'))",
    "UPDATE app_topics SET reach = 'hub' WHERE id = 1",
    'ALTER TABLE app_topics DROP COLUMN search_excluded',
    'ALTER TABLE app_topics ADD COLUMN guidance_by TEXT',
    "UPDATE app_topics SET guidance_by = (SELECT coalesce(m.key_name, m.key_id) FROM app_key_reach m WHERE m.kind = 'topic' AND m.resource_id = app_topics.id LIMIT 1) WHERE description <> '' OR instructions <> ''",
    'ALTER TABLE app_chat_operations ADD COLUMN power TEXT',
    'DROP INDEX app_key_reach_resource',
    'ALTER TABLE app_key_reach RENAME TO app_made_by',
    'CREATE INDEX app_made_by_resource ON app_made_by (kind, resource_id)',
  ].join(BREAK),
}
