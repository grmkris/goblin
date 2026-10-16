import { describe, expect, it } from 'vitest'
import { GrantStore } from '../../src/mcp/grants/grants.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

describe('batch grant persistence', () => {
  it('rolls back tool writes if an App resource write fails', () => {
    const { db, sqlite, close } = chatDatabase()
    try {
      const store = new GrantStore(durable(db))
      const tool = { connectionId: 'notes', capability: 'tool' as const, name: 'open' }
      sqlite.exec(`CREATE TRIGGER fail_resource BEFORE INSERT ON app_mcp_grants
        WHEN NEW.capability = 'resource' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`)
      expect(() =>
        store.setMany(
          [
            { grant: tool, allowed: true },
            { grant: { connectionId: 'notes', capability: 'resource', name: 'ui://notes/board' }, allowed: true },
          ],
          1,
        ),
      ).toThrow()
      expect(store.list()).toEqual([])
    } finally {
      close()
    }
  })

  it('preserves existing approval policies and unrelated connections across a batch', () => {
    const { db, close } = chatDatabase()
    try {
      const store = new GrantStore(durable(db))
      const tool = { connectionId: 'notes', capability: 'tool' as const, name: 'open' }
      const other = { ...tool, connectionId: 'other' }
      store.set(tool, true, 1)
      store.set(other, true, 1)
      store.setAskFirst(tool, true)
      const policy = store.policy(tool)
      store.setMany([{ grant: tool, allowed: true }], 2)
      expect(store.policy(tool)).toEqual(policy)
      store.setMany([{ grant: tool, allowed: false }], 3)
      expect(store.allows(tool)).toBe(false)
      expect(store.allows(other)).toBe(true)
    } finally {
      close()
    }
  })
})
