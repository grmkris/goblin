import { BREAK, type Migration } from './migration.ts'

/** Preserve stored turn powers and server attribution when the key credential and its extra retire (ADR 0125). */
export const NO_KEY_POWERS: Migration = {
  key: '20261027000000_no_key_powers',
  tables: ['app_chat_operations'],
  sql: [
    "UPDATE app_chat_operations SET origin = 'app' WHERE origin = 'key'",
    `UPDATE app_chat_operations SET power = json_set(power, '$.extras', json((SELECT json_group_array(value) FROM json_each(app_chat_operations.power, '$.extras') WHERE value <> 'keys')))
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(app_chat_operations.power) THEN app_chat_operations.power ELSE '{}' END, '$.extras') WHERE value = 'keys')`,
  ].join(BREAK),
}
