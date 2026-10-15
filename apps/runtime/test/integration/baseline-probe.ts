import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { isVendorTable } from '../../src/storage/vendor.ts'

/** A snapshot inside the fixture only; opaque Cloudflare internals and the migration journal are never read. */
const vendorState = (storage: DurableObjectStorage) => {
  const definitions = storage.sql
    .exec<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .toArray()
    .filter(({ name }) => isVendorTable(name) && !name.startsWith('_cf_') && !name.startsWith('__drizzle'))
  return definitions.map(({ name, sql }) => ({
    name,
    sql,
    rows: storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray(),
  }))
}

/** Real Agent/Pi state exists before the first application migration; neither application pass may change it. */
export function baselinePreservation(storage: DurableObjectStorage) {
  const before = vendorState(storage)
  const applicationBefore = storage.sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB 'app_*'")
    .one().n
  runApplicationMigrations(storage)
  const first = vendorState(storage)
  storage.sql.exec("INSERT INTO app_usage_daily (day, tokens, updated_at) VALUES ('2026-10-15', 17, 1)")
  runApplicationMigrations(storage)
  const second = vendorState(storage)
  return {
    applicationBefore,
    vendorTables: before.map(({ name }) => name),
    vendorRows: before.reduce((count, { rows }) => count + rows.length, 0),
    firstPreserved: JSON.stringify(first) === JSON.stringify(before),
    secondPreserved: JSON.stringify(second) === JSON.stringify(before),
    tokens: storage.sql.exec<{ tokens: number }>('SELECT tokens FROM app_usage_daily').one().tokens,
    migrations: storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM __drizzle_migrations').one().n,
  }
}
