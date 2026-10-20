import type { ResidentStatus } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appResident } from './storage/schema.ts'

// Resident authority: what lets tools run without a live browser session (chat, inbound MCP clients, routines and
// channels), kept in the agent's one `app_resident` row. The owner's first signed-in action grants it, and it lasts
// until they revoke it (ADR 0088); a revocation is sticky until the owner enables it again. Programs use the `Resident`
// service (mcp/service.ts), built over these functions in layers/core.ts.

export type { ResidentStatus }

/** The database resident authority lives in: its one `app_resident` row. */
type Database = SQLiteAsyncDatabase<'sync', unknown>

/** Resident authority as its row says. */
export function residentStatus(db: Database): ResidentStatus {
  const row = db.select().from(appResident).where(eq(appResident.id, 1)).get()
  if (row === undefined) return { state: 'never' }
  if (row.revokedAt === null) return { state: 'active', grantedAt: row.grantedAt }
  return { state: 'revoked', grantedAt: row.grantedAt, revokedAt: row.revokedAt }
}

/** The owner's signed-in activity: grants it the first time, and never clears a revocation. */
export function grantResident(db: Database, now: number): void {
  db.insert(appResident).values({ id: 1, grantedAt: now }).onConflictDoNothing().run()
}

/** Revokes it, sticky until the owner enables it again. */
export function revokeResident(db: Database, now: number): void {
  grantResident(db, now)
  db.update(appResident).set({ revokedAt: now }).where(eq(appResident.id, 1)).run()
}

/** Clears a revocation. */
export function enableResident(db: Database, now: number): void {
  grantResident(db, now)
  db.update(appResident).set({ revokedAt: null }).where(eq(appResident.id, 1)).run()
}
