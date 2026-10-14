import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appModelEndpoint } from '../storage/inference.ts'

/** The owner's endpoint as stored: its key still sealed. */
export type StoredEndpoint = {
  readonly baseUrl: string
  readonly keySealed: string
  readonly models: readonly [string, ...string[]]
}

const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NonEmptyArray(Schema.String)))

/**
 * The ids of the models on offer now, read at each call: the owner's endpoint's when they set one, else `deployment`'s.
 * For a synchronous store that checks a pick (Personas); the picker itself reads `Inference`.
 */
export const offeredModels = (db: DrizzleSqliteDODatabase, deployment: readonly string[]) => (): readonly string[] =>
  endpointStore(db).get()?.models ?? deployment

/** The owner's endpoint row (one at most), over the agent's database. */
export const endpointStore = (db: DrizzleSqliteDODatabase) => ({
  /** The stored endpoint, its default model first; none without a row, or with a model list that does not decode. */
  get: (): StoredEndpoint | undefined => {
    const row = db.select().from(appModelEndpoint).where(eq(appModelEndpoint.id, 1)).get()
    if (row === undefined) return undefined
    const listed = Option.getOrUndefined(decodeModels(row.models))
    if (listed === undefined) return undefined
    return {
      baseUrl: row.baseUrl,
      keySealed: row.keySealed,
      models: [row.model, ...listed.filter((id) => id !== row.model)],
    }
  },
  set: (endpoint: StoredEndpoint, now: number): void => {
    const values = {
      baseUrl: endpoint.baseUrl,
      keySealed: endpoint.keySealed,
      models: JSON.stringify(endpoint.models),
      model: endpoint.models[0],
      updatedAt: now,
    }
    db.insert(appModelEndpoint)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: appModelEndpoint.id, set: values })
      .run()
  },
  clear: (): void => {
    db.delete(appModelEndpoint).where(eq(appModelEndpoint.id, 1)).run()
  },
})
