import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { BASELINE } from './migrations/baseline.ts'
import { INVOCATION_REASON } from './migrations/invocation-reason.ts'
import { KEY_REACH } from './migrations/key-reach.ts'
import { PERSONA_THINKING } from './migrations/persona-thinking.ts'
import { PERSONA_TOOL_MODE } from './migrations/persona-tool-mode.ts'
import { PERSONA_TOOLS } from './migrations/persona-tools.ts'
import { RESIDENT_UNTIL_REVOKED } from './migrations/resident-until-revoked.ts'
import { SOURCE_PROPOSER } from './migrations/source-proposer.ts'
import { assertApplicationTable } from './vendor.ts'

/**
 * The fresh application baseline, then the forward migrations production needed without a reset (ADRs 0068, 0081, 0083,
 * 0088, 0100, 0101, 0102). An edit to the baseline ships only with a disposable dev reset.
 *
 * @internal Unit tests apply these same statements to SQLite and compare them with the live Drizzle declarations.
 */
export const MIGRATIONS = [
  BASELINE,
  KEY_REACH,
  INVOCATION_REASON,
  RESIDENT_UNTIL_REVOKED,
  SOURCE_PROPOSER,
  PERSONA_THINKING,
  PERSONA_TOOLS,
  PERSONA_TOOL_MODE,
] as const

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
