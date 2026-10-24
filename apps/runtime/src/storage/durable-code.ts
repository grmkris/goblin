import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ScriptResult } from '../agent-apps/script-result.ts'

export type CodeCheckpoint = {
  readonly codeHash: string
  readonly build: string
  readonly expiresAt: number
  readonly fuel: number
  /** Native only: remaining CPU; an in-flight slice's reservation has already been subtracted. */
  readonly cpuRemainingMs?: number
  readonly sequence: number
  readonly steps: number
  readonly call?: { readonly callName: string; readonly args: unknown }
  readonly result?: ScriptResult
}

/** Trusted, server-only heap bytes (base64) and build/run-bound integrity. Never accepted from a client. */
export const appCodeRuns = sqliteTable('app_code_runs', {
  id: text('id').primaryKey().notNull(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<CodeCheckpoint>().notNull(),
  base: text('base').notNull(),
  delta: text('delta').notNull(),
  digest: text('digest').notNull(),
})

/** One durable intent and response per host call. An unrecorded non-read-only outcome is indeterminate. */
export const appCodeCalls = sqliteTable(
  'app_code_calls',
  {
    run: text('run').notNull(),
    sequence: integer('sequence').notNull(),
    response: text('response', { mode: 'json' }).$type<{
      readonly ok: boolean
      readonly value?: unknown
      readonly error?: string
    }>(),
  },
  (table) => [primaryKey({ columns: [table.run, table.sequence] })],
)
