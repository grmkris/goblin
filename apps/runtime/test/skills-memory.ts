// In-memory skills state for unit tests, with the SQLite stores' semantics (src/skills/store.ts).
import type { Activation, DraftLog, DraftRecord, SkillState } from '../src/skills/store.ts'

/** The skills state in memory, with the SQLite store's semantics. */
export class MemorySkillState implements SkillState {
  readonly #sources = new Set<string>()
  readonly #activations = new Map<string, Activation[]>()
  readonly files = new Map<string, Uint8Array>()
  enabled = (connectionId: string) => this.#sources.has(connectionId)
  sources = () => [...this.#sources]
  setEnabled(connectionId: string, enabled: boolean) {
    if (enabled) this.#sources.add(connectionId)
    else this.#sources.delete(connectionId)
  }
  activation = (sessionId: string, connectionId: string, uri: string) =>
    this.#activations.get(sessionId)?.find((item) => item.connectionId === connectionId && item.entry.uri === uri)
  activations = (sessionId: string) => this.#activations.get(sessionId) ?? []
  activate(sessionId: string, activation: Activation) {
    const kept = this.activations(sessionId).filter(
      (item) => !(item.connectionId === activation.connectionId && item.entry.uri === activation.entry.uri),
    )
    this.#activations.set(sessionId, [...kept, activation])
  }
  file = (digest: string) => this.files.get(digest)
  storeFile(digest: string, bytes: Uint8Array) {
    this.files.set(digest, bytes)
  }
}

/** The learner's draft records in memory. */
export class MemoryDraftLog implements DraftLog {
  readonly rows = new Map<string, DraftRecord & { readonly createdAt: number }>()
  countSince = (since: number) => [...this.rows.values()].filter((row) => row.createdAt >= since).length
  known = (contentHash: string) => this.rows.has(contentHash)
  add(record: DraftRecord, now: number) {
    this.rows.set(record.contentHash, { ...record, createdAt: now })
  }
  forget(contentHash: string) {
    this.rows.delete(contentHash)
  }
}
