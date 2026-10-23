import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appCodeCalls, appCodeRuns, type CodeCheckpoint } from '../../storage/durable-code.ts'
import { sha256Hex } from '../../runtime/digest.ts'

export type CodeRow = typeof appCodeRuns.$inferSelect
export type CallResponse = NonNullable<typeof appCodeCalls.$inferSelect.response>

/** Base64 keeps the driver independent of Node Buffer and the SQLite blob adapter. */
export const encodeSnapshot = (bytes: Uint8Array): string => {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}
export const decodeSnapshot = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

export const checkpointDigest = (row: Omit<CodeRow, 'digest'>): Promise<string> =>
  sha256Hex(JSON.stringify([row.id, row.checkpoint, row.base, row.delta]))

/** Application-owned rows only. Every write is synchronous; no transaction crosses a host wait. */
export class CodeStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }
  read(id: string): CodeRow | undefined {
    return this.#db.select().from(appCodeRuns).where(eq(appCodeRuns.id, id)).get()
  }
  async put(id: string, checkpoint: CodeCheckpoint, base: string, delta: string): Promise<CodeRow> {
    const data = { id, checkpoint, base, delta }
    const row = { ...data, digest: await checkpointDigest(data) }
    this.#db.insert(appCodeRuns).values(row).onConflictDoUpdate({ target: appCodeRuns.id, set: row }).run()
    return row
  }
  call(run: string, sequence: number) {
    return this.#db
      .select()
      .from(appCodeCalls)
      .where(and(eq(appCodeCalls.run, run), eq(appCodeCalls.sequence, sequence)))
      .get()
  }
  intent(run: string, sequence: number): void {
    this.#db.insert(appCodeCalls).values({ run, sequence }).run()
  }
  complete(run: string, sequence: number, response: CallResponse): void {
    this.#db
      .update(appCodeCalls)
      .set({ response })
      .where(and(eq(appCodeCalls.run, run), eq(appCodeCalls.sequence, sequence)))
      .run()
  }
}
