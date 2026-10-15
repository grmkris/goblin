import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FileStore } from '../src/files/store.ts'

/**
 * The agent's SQLite as Shell's Workspace reads a storage that is neither a Durable Object's nor D1: the two calls it
 * makes, over node:sqlite.
 */
const sqlite = (): SqlStorage => {
  const db = new DatabaseSync(':memory:')
  const backend = {
    query: (sql: string, ...params: (string | number | null | Uint8Array)[]) => db.prepare(sql).all(...params),
    run: (sql: string, ...params: (string | number | null | Uint8Array)[]) => {
      db.prepare(sql).run(...params)
    },
  }
  // SAFETY: Workspace takes any storage with `query` and `run` (`@cloudflare/shell`'s toBackend) and calls nothing else.
  return backend as never
}

describe("the owner's files without the files bucket (ADR 0064, unit)", () => {
  it('keeps a small file in SQLite, refuses one over 128 KiB as too large, and has nothing to purge', async () => {
    const store = new FileStore(sqlite(), undefined, () => 'owner')
    expect(await store.write('owner', '/uploads/note.txt', 'hello', 'text/plain', 5)).toMatchObject({ size: 5 })
    expect((await store.text('/uploads/note.txt', 0, 100)).text).toBe('hello')
    const large = new Uint8Array(200 * 1024)
    await expect(
      store.write('owner', '/uploads/large.bin', large, 'application/octet-stream', large.byteLength),
    ).rejects.toMatchObject({ _tag: 'PayloadTooLarge', limit: 128 * 1024 })
    await store.purge()
  })
})
