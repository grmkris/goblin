import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpEntrypoints } from '../storage/schema.ts'

/**
 * The tool each connection's own App opens from (its global entrypoint, ADR 0053), as its last whole tool list declared
 * it: kept so the App's Open and pin outlive the connection and the object.
 */
export interface Entrypoints {
  /** The entrypoint `connectionId`'s tools last declared; none when they declared none. */
  of(connectionId: string): string | undefined
  /** Keeps `tool` as `connectionId`'s entrypoint (epoch milliseconds), or forgets it with none. */
  set(connectionId: string, tool: string | undefined, at: number): void
}

/** The entrypoints in the agent's SQLite (`app_mcp_entrypoints`). */
export class ConnectionEntrypoints implements Entrypoints {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }
  of(connectionId: string): string | undefined {
    return this.#db
      .select({ tool: appMcpEntrypoints.tool })
      .from(appMcpEntrypoints)
      .where(eq(appMcpEntrypoints.connectionId, connectionId))
      .get()?.tool
  }
  set(connectionId: string, tool: string | undefined, at: number): void {
    if (tool === undefined) {
      this.#db.delete(appMcpEntrypoints).where(eq(appMcpEntrypoints.connectionId, connectionId)).run()
      return
    }
    this.#db
      .insert(appMcpEntrypoints)
      .values({ connectionId, tool, at })
      .onConflictDoUpdate({ target: appMcpEntrypoints.connectionId, set: { tool, at } })
      .run()
  }
}
