import type { ReachKind } from '@goblin/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appGrantReach, appGrantSync } from '../storage/grants.ts'

// The agent's mirror of the grants that reach it (ADR 0114, `storage/grants.ts`): synchronous reads and writes over
// its SQLite. Reach checks join it; `Grants.sync` replaces a grant's part in one transaction.

type Db<R = unknown> = SQLiteAsyncDatabase<'sync', R>

/** Whether a kind of reach is all of the workspace's, or a list. */
export type Coverage = 'all' | 'list'

/** A grant as the mirror holds it: each kind's coverage, and the generation it was read at. */
export interface Mirrored {
  readonly generation: number
  readonly topics: Coverage
  readonly personas: Coverage
  readonly connections: Coverage
}

const FIELD = { topic: 'topics', persona: 'personas', connection: 'connections' } as const satisfies Record<
  ReachKind,
  keyof Mirrored
>

/** Grant `grantId` as the mirror holds it; none before its first sync. */
export const mirrored = <R>(db: Db<R>, grantId: string): Mirrored | undefined =>
  db
    .select({
      generation: appGrantSync.generation,
      topics: appGrantSync.topics,
      personas: appGrantSync.personas,
      connections: appGrantSync.connections,
    })
    .from(appGrantSync)
    .where(eq(appGrantSync.grantId, grantId))
    .get()

/** One listed id: what it names and its id. */
export interface MirrorItem {
  readonly kind: ReachKind
  readonly id: string
}

/**
 * Grant `grantId` as the auth store said at `generation`: its coverage and listed ids, replacing what the mirror held,
 * in one transaction. No coverage (it no longer reaches this workspace) leaves it nothing.
 */
export const replaceMirror = (
  db: Db,
  grantId: string,
  read: { readonly coverage: Mirrored | undefined; readonly items: readonly MirrorItem[] },
  now: number,
): void => {
  db.transaction((tx) => {
    tx.delete(appGrantReach).where(eq(appGrantReach.grantId, grantId)).run()
    const { coverage } = read
    if (coverage === undefined) {
      tx.delete(appGrantSync).where(eq(appGrantSync.grantId, grantId)).run()
      return
    }
    tx.insert(appGrantSync)
      .values({ grantId, ...coverage, syncedAt: now })
      .onConflictDoUpdate({ target: appGrantSync.grantId, set: { ...coverage, syncedAt: now } })
      .run()
    for (const item of read.items)
      tx.insert(appGrantReach).values({ grantId, kind: item.kind, resourceId: item.id }).onConflictDoNothing().run()
  })
}

/** Adds one id to grant `grantId`'s list in the mirror, as its own create added it to the auth store's. */
export const appendMirror = (db: Db, grantId: string, item: MirrorItem): void => {
  db.insert(appGrantReach).values({ grantId, kind: item.kind, resourceId: item.id }).onConflictDoNothing().run()
}

/**
 * Whether grant `grantId` reaches the `kind` with `id` as the mirror holds it: all of its kind, or listed. A grant the
 * mirror does not hold reaches nothing.
 */
export const mirrorReaches = <R>(db: Db<R>, grantId: string, kind: ReachKind, id: string): boolean => {
  const held = mirrored(db, grantId)
  if (held === undefined) return false
  if (held[FIELD[kind]] === 'all') return true
  return (
    db
      .select({ id: appGrantReach.resourceId })
      .from(appGrantReach)
      .where(and(eq(appGrantReach.grantId, grantId), eq(appGrantReach.kind, kind), eq(appGrantReach.resourceId, id)))
      .get() !== undefined
  )
}

/** The numbered ids grant `grantId` lists of `kind`, as a subquery: a list page over them is one statement. */
export const listedIds = <R>(db: Db<R>, grantId: string, kind: 'topic' | 'persona') =>
  db
    .select({ id: sql<number>`CAST(${appGrantReach.resourceId} AS INTEGER)` })
    .from(appGrantReach)
    .where(and(eq(appGrantReach.grantId, grantId), eq(appGrantReach.kind, kind)))
