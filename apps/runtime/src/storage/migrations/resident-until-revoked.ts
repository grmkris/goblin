import { BREAK, type Migration } from './migration.ts'

/**
 * Resident authority lasts until the owner revokes it (ADR 0088): the row keeps when it was first granted, and its
 * expiry goes. A forward migration so production keeps its agents; it folds into the baseline at the next reset the
 * owner decides on.
 */
export const RESIDENT_UNTIL_REVOKED: Migration = {
  key: '20261020200000_resident_until_revoked',
  tables: ['app_resident'],
  sql: [
    'ALTER TABLE app_resident RENAME COLUMN renewed_at TO granted_at',
    'ALTER TABLE app_resident DROP COLUMN expires_at',
  ].join(BREAK),
}
