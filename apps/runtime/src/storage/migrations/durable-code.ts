import { BREAK, type Migration } from './migration.ts'

/** Additive, default-off spike storage. No vendor tables or existing migrations change. */
export const DURABLE_CODE: Migration = {
  key: '20261024000000_durable_code',
  tables: ['app_code_runs', 'app_code_calls'],
  sql: [
    'CREATE TABLE app_code_runs (id TEXT PRIMARY KEY NOT NULL, checkpoint TEXT NOT NULL, base TEXT NOT NULL, delta TEXT NOT NULL, digest TEXT NOT NULL)',
    'CREATE TABLE app_code_calls (run TEXT NOT NULL, sequence INTEGER NOT NULL, response TEXT, PRIMARY KEY (run, sequence))',
  ].join(BREAK),
}
