import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { BASE_MIGRATIONS } from './migrations/base.ts'
import { CONVERSATION_MIGRATIONS } from './migrations/conversation.ts'
import { DECISION_MIGRATIONS } from './migrations/decisions.ts'
import { INFERENCE_MIGRATIONS } from './migrations/inference.ts'
import { MCP_MIGRATIONS } from './migrations/mcp.ts'
import type { Migration } from './migrations/migration.ts'
import { NOTICE_MIGRATIONS } from './migrations/notices.ts'
import { ONBOARDING_MIGRATIONS } from './migrations/onboarding.ts'
import { PAY_MIGRATIONS } from './migrations/pay.ts'
import { SETUP_MIGRATIONS } from './migrations/setup.ts'
import { SIDEBAR_MIGRATIONS } from './migrations/sidebar.ts'
import { SOURCE_MIGRATIONS } from './migrations/sources.ts'
import { TELEGRAM_MIGRATIONS } from './migrations/telegram.ts'
import { assertApplicationTable } from './vendor.ts'

/**
 * Every application migration, the area lists merged in key order.
 *
 * @internal Exported for the unit tests, which build the real schema in `node:sqlite` from these statements and check
 * the order of the keys; the agent applies them only through `runApplicationMigrations`.
 */
export const MIGRATIONS: readonly Migration[] = [
  ...BASE_MIGRATIONS,
  ...CONVERSATION_MIGRATIONS,
  ...DECISION_MIGRATIONS,
  ...SETUP_MIGRATIONS,
  ...NOTICE_MIGRATIONS,
  ...MCP_MIGRATIONS,
  ...ONBOARDING_MIGRATIONS,
  ...PAY_MIGRATIONS,
  ...SIDEBAR_MIGRATIONS,
  ...TELEGRAM_MIGRATIONS,
  ...INFERENCE_MIGRATIONS,
  ...SOURCE_MIGRATIONS,
].toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
