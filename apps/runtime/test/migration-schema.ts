import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** All current Drizzle declarations, discovered so a new schema file cannot silently escape baseline parity. */
export async function declaredTables() {
  const directory = new URL('../src/storage/', import.meta.url)
  const tables = new Map<string, ReturnType<typeof getTableConfig>>()
  for (const file of readdirSync(fileURLToPath(directory.href))) {
    if (!file.endsWith('.ts') || file === 'migrations.ts' || file === 'vendor.ts') continue
    const module: Record<string, unknown> = await import(new URL(file, directory).href)
    for (const value of Object.values(module)) {
      if (!is(value, SQLiteTable)) continue
      const config = getTableConfig(value)
      tables.set(config.name, config)
    }
  }
  return tables
}
