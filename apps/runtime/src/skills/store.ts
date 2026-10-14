import { and, count, eq, gte, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import {
  appSkillCatalogState,
  appSkillActivations,
  appSkillDrafts,
  appSkillFiles,
  appSkillSources,
} from '../storage/schema.ts'
import { SkillEntry } from './protocol.ts'

/** A file is cached only up to this size: a Durable Object SQLite row stays well under its 2 MB limit. */
export const MAX_CACHED_FILE_BYTES = 1_048_576

/** What one conversation activated: the server, and the entry exactly as it was loaded. */
export type Activation = { readonly connectionId: string; readonly entry: SkillEntry; readonly activatedAt: number }

/** The skills state the Agent DO keeps: owner switches, per-conversation activations, verified bytes. */
export interface SkillState {
  /** Whether the owner uses skills from this server. */
  catalogState?(connectionId: string): {
    readonly dirty: number
    readonly refreshed: number
    readonly unavailable: boolean
  }
  dirtyCatalog?(connectionId: string, unavailable: boolean, now: number): void
  refreshedCatalog?(connectionId: string, generation: number, now: number): boolean
  enabled(connectionId: string): boolean
  sources(): readonly string[]
  setEnabled(connectionId: string, enabled: boolean, now: number): void
  activation(sessionId: string, connectionId: string, uri: string): Activation | undefined
  activations(sessionId: string): readonly Activation[]
  activate(sessionId: string, activation: Activation): void
  /** Cached bytes by digest; the caller verifies them again before use. */
  file(digest: string): Uint8Array | undefined
  storeFile(digest: string, bytes: Uint8Array, now: number): void
}

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(SkillEntry))
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(SkillEntry))
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

export class SqliteSkillState implements SkillState {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  catalogState(connectionId: string) {
    const row = this.#db
      .select()
      .from(appSkillCatalogState)
      .where(eq(appSkillCatalogState.connectionId, connectionId))
      .get()
    return {
      dirty: row?.dirtyGeneration ?? 0,
      refreshed: row?.refreshedGeneration ?? 0,
      unavailable: row?.lastError === 'terminated',
    }
  }
  dirtyCatalog(connectionId: string, unavailable: boolean, now: number): void {
    this.#db
      .insert(appSkillCatalogState)
      .values({
        connectionId,
        dirtyGeneration: 1,
        refreshedGeneration: 0,
        nextRetryAt: now,
        lastError: unavailable ? 'terminated' : null,
      })
      .onConflictDoUpdate({
        target: appSkillCatalogState.connectionId,
        set: {
          dirtyGeneration: sql`${appSkillCatalogState.dirtyGeneration} + 1`,
          nextRetryAt: now,
          lastError: unavailable ? 'terminated' : null,
        },
      })
      .run()
  }
  refreshedCatalog(connectionId: string, generation: number, now: number): boolean {
    this.#db
      .update(appSkillCatalogState)
      .set({ refreshedGeneration: generation, nextRetryAt: now + 300_000, lastError: null })
      .where(
        and(eq(appSkillCatalogState.connectionId, connectionId), eq(appSkillCatalogState.dirtyGeneration, generation)),
      )
      .run()
    return this.catalogState(connectionId).dirty === generation
  }

  enabled(connectionId: string): boolean {
    return (
      this.#db
        .select({ connectionId: appSkillSources.connectionId })
        .from(appSkillSources)
        .where(eq(appSkillSources.connectionId, connectionId))
        .get() !== undefined
    )
  }

  sources(): readonly string[] {
    return this.#db
      .select({ connectionId: appSkillSources.connectionId })
      .from(appSkillSources)
      .all()
      .map((row) => row.connectionId)
  }

  setEnabled(connectionId: string, enabled: boolean, now: number): void {
    if (enabled) {
      this.#db.insert(appSkillSources).values({ connectionId, enabledAt: now }).onConflictDoNothing().run()
      return
    }
    this.#db.delete(appSkillSources).where(eq(appSkillSources.connectionId, connectionId)).run()
  }

  activation(sessionId: string, connectionId: string, uri: string): Activation | undefined {
    const row = this.#db
      .select()
      .from(appSkillActivations)
      .where(
        and(
          eq(appSkillActivations.sessionId, sessionId),
          eq(appSkillActivations.connectionId, connectionId),
          eq(appSkillActivations.uri, uri),
        ),
      )
      .get()
    return row === undefined ? undefined : { connectionId, entry: decodeEntry(row.entry), activatedAt: row.activatedAt }
  }

  activations(sessionId: string): readonly Activation[] {
    return this.#db
      .select()
      .from(appSkillActivations)
      .where(eq(appSkillActivations.sessionId, sessionId))
      .all()
      .map((row) => ({ connectionId: row.connectionId, entry: decodeEntry(row.entry), activatedAt: row.activatedAt }))
  }

  activate(sessionId: string, activation: Activation): void {
    const values = {
      sessionId,
      connectionId: activation.connectionId,
      uri: activation.entry.uri,
      entry: encodeEntry(activation.entry),
      activatedAt: activation.activatedAt,
    }
    this.#db
      .insert(appSkillActivations)
      .values(values)
      .onConflictDoUpdate({
        target: [appSkillActivations.sessionId, appSkillActivations.connectionId, appSkillActivations.uri],
        set: { entry: values.entry, activatedAt: values.activatedAt },
      })
      .run()
  }

  file(digest: string): Uint8Array | undefined {
    const row = this.#db
      .select({ content: appSkillFiles.content })
      .from(appSkillFiles)
      .where(eq(appSkillFiles.digest, digest))
      .get()
    return row === undefined ? undefined : fromBase64(row.content)
  }

  storeFile(digest: string, bytes: Uint8Array, now: number): void {
    if (bytes.byteLength > MAX_CACHED_FILE_BYTES) return
    this.#db
      .insert(appSkillFiles)
      .values({ digest, content: toBase64(bytes), storedAt: now })
      // A verified refetch repairs a cache row that was corrupted after it was written.
      .onConflictDoUpdate({
        target: appSkillFiles.digest,
        set: { content: toBase64(bytes), storedAt: now },
      })
      .run()
  }
}

/**
 * A skill draft the learner wrote to the owner's files: its content hash, the skill it names, and the skill it improves
 * with that skill's server, when it improves one.
 */
export type DraftRecord = {
  readonly contentHash: string
  readonly name: string
  readonly base: { readonly connectionId: string; readonly uri: string } | undefined
}

/** The learner's record of the drafts it wrote (skills/learner.ts). */
export interface DraftLog {
  /** Drafts written since `since` (ms). */
  countSince(since: number): number
  /** A draft with this content was written before. */
  known(contentHash: string): boolean
  add(record: DraftRecord, now: number): void
  forget(contentHash: string): void
}

/**
 * The draft log in `app_skill_drafts`. A new skill's draft has no server (`connection_id` is empty); its review is the
 * owner's, in their files, so every row stays `open`.
 */
export class SqliteDraftLog implements DraftLog {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  countSince(since: number): number {
    return (
      this.#db.select({ n: count() }).from(appSkillDrafts).where(gte(appSkillDrafts.createdAt, since)).get()?.n ?? 0
    )
  }

  known(contentHash: string): boolean {
    return (
      this.#db
        .select({ hash: appSkillDrafts.contentHash })
        .from(appSkillDrafts)
        .where(eq(appSkillDrafts.contentHash, contentHash))
        .get() !== undefined
    )
  }

  add({ contentHash, name, base }: DraftRecord, now: number): void {
    this.#db
      .insert(appSkillDrafts)
      .values({
        contentHash,
        connectionId: base?.connectionId ?? '',
        name,
        baseUri: base?.uri ?? null,
        draftId: null,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  forget(contentHash: string): void {
    this.#db.delete(appSkillDrafts).where(eq(appSkillDrafts.contentHash, contentHash)).run()
  }
}
