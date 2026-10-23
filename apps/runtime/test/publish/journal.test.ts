import type { ConversationUpdated } from '@goblin/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorOf } from '../../src/publish/event.ts'
import { behind, listened, notePoll, page, pruneJournal, record } from '../../src/publish/journal.ts'
import {
  type Lease,
  claimDue,
  endExpired,
  endHolder,
  leaseCounts,
  leaseOf,
  nextDue,
  renewLease,
  settle,
} from '../../src/publish/leases.ts'
import { PUBLISH_LIMITS } from '../../src/publish/policy.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const databases: ReturnType<typeof chatDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const NOW = 1_800_000_000_000

/** An agent's database with two keys whose grants list one Topic each (ADR 0114): k1 Topic 2, k2 Topic 3. */
const setup = () => {
  const database = chatDatabase()
  databases.push(database)
  const insert = database.sqlite.prepare(
    "INSERT INTO app_topics (id, name, chat_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, 1)",
  )
  insert.run(2, 'Room A', '20')
  insert.run(3, 'Room B', '30')
  const synced = database.sqlite.prepare(
    "INSERT INTO app_grant_sync (grant_id, generation, topics, personas, connections, synced_at) VALUES (?, 1, 'list', 'all', 'all', 1)",
  )
  const reach = database.sqlite.prepare(
    "INSERT INTO app_grant_reach (grant_id, kind, resource_id) VALUES (?, 'topic', ?)",
  )
  for (const [grant, topic] of [
    ['k1', '2'],
    ['k2', '3'],
  ] as const) {
    synced.run(grant)
    reach.run(grant, topic)
  }
  return { db: durable(database.db), sqlite: database.sqlite }
}
type Db = ReturnType<typeof setup>['db']

const lease = (db: Db, id: string, principal: string, selector: { topic?: number; chat?: string } = {}): Lease => {
  const row: Lease = {
    id,
    principal,
    grantId: principal.startsWith('key:') ? principal.slice('key:'.length) : null,
    name: 'conversation.updated',
    argumentsJson: '{}',
    topicId: selector.topic ?? null,
    chatId: selector.chat ?? null,
    url: `https://hooks.example.com/${id}`,
    secret: 'sealed',
    refreshBefore: NOW + 3_600_000,
    status: 'active',
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
  renewLease(db, row)
  return row
}

let ids = 0
const wake = (chat: string, topicId: number, change: Partial<ConversationUpdated> = {}, at = NOW) => ({
  data: { chat, topic: String(topicId), entry: 1, activity: 'working' as const, attention: 0, ...change },
  eventId: `evt-${(ids += 1)}`,
  at,
})

const owed = (sqlite: ReturnType<typeof setup>['sqlite'], id: string) =>
  sqlite
    .prepare(
      'SELECT kind, chat_id AS chat, journal_seq AS seq, attempts, claim, body FROM app_publish_deliveries WHERE subscription_id = ? ORDER BY seq',
    )
    .all(id)

describe('the published journal (ADR 0112)', () => {
  it('journals a wake once and owes it to each lease that takes it, a key only in the Topics its grant lists', () => {
    const { db, sqlite } = setup()
    lease(db, 'all-k1', 'key:k1')
    lease(db, 'room-b-k1', 'key:k1', { topic: 3 })
    lease(db, 'client', 'client:c1:u1')
    lease(db, 'chat-20', 'key:k1', { chat: '20' })
    expect(record(db, wake('20', 2))?.queued).toBe(3)
    expect(record(db, wake('30', 3))?.queued).toBe(1)
    expect(owed(sqlite, 'client')).toHaveLength(2)
    expect(owed(sqlite, 'room-b-k1')).toEqual([])
    // Nothing changed: nothing is journaled or owed.
    expect(record(db, wake('20', 2))).toBeUndefined()
    expect(record(db, wake('20', 2, { activity: 'idle' }))?.seq).toBe(3)
  })

  it('owes a lease at most one waiting wake per chat, the newest, and a newer one beside one being sent', () => {
    const { db, sqlite } = setup()
    lease(db, 'all-k1', 'key:k1')
    record(db, wake('20', 2, { entry: 1 }))
    const second = record(db, wake('20', 2, { entry: 2 }))
    expect(owed(sqlite, 'all-k1')).toEqual([expect.objectContaining({ chat: '20', seq: second?.seq, attempts: 0 })])
    const [claimed] = claimDue(db, NOW, 'drain-1', 10)
    if (claimed === undefined) throw new Error('nothing claimed')
    const third = record(db, wake('20', 2, { entry: 3 }))
    expect(owed(sqlite, 'all-k1')).toHaveLength(2)
    // The one sent fails and is tried again: the newer wake takes its place, keeping its attempt.
    settle(db, claimed, 'drain-1', { state: 'retry', atMs: NOW + 15_000, reason: 'http_5xx' }, NOW)
    expect(owed(sqlite, 'all-k1')).toEqual([expect.objectContaining({ seq: third?.seq, attempts: 1, claim: null })])
    expect(leaseOf(db, 'all-k1')?.lastError).toBe('http_5xx')
    // The wake is armed for the retry, not only for the lease's end.
    expect(nextDue(db)).toBe(NOW + 15_000)
    expect(claimDue(db, NOW + 14_999, 'drain-2', 10)).toEqual([])
    expect(claimDue(db, NOW + 15_000, 'drain-2', 10)).toHaveLength(1)
    expect(nextDue(db)).toBe(NOW + 15_000 + 30_000)
  })

  it('pages a poll after a cursor; null answers where now is; a key reads only the Topics its grant lists and selectors filter', () => {
    const { db } = setup()
    for (const [chat, topic] of [
      ['20', 2],
      ['21', 2],
      ['30', 3],
      ['20', 2],
    ] as const)
      record(db, wake(chat, topic, { entry: (ids += 1) }))
    const query = { name: 'conversation.updated', maxEvents: 2, cutoff: 0 }
    const now = page(db, { ...query, grant: 'k1', cursor: null })
    expect(now).toMatchObject({ events: [], cursor: cursorOf(4), truncated: false, hasMore: false })
    const first = page(db, { ...query, grant: 'k1', cursor: cursorOf(0) })
    expect(first.events.map(({ data }) => data.chat)).toEqual(['20', '21'])
    expect(first).toMatchObject({ hasMore: true, cursor: cursorOf(2) })
    const rest = page(db, { ...query, grant: 'k1', cursor: first.cursor })
    expect(rest.events.map(({ data }) => data.chat)).toEqual(['20'])
    expect(rest).toMatchObject({ hasMore: false, cursor: cursorOf(4) })
    expect(page(db, { ...query, grant: 'k2', cursor: cursorOf(0) }).events.map(({ data }) => data.chat)).toEqual(['30'])
    const everyone = page(db, { ...query, maxEvents: 100, grant: undefined, cursor: cursorOf(0), chat: '20' })
    expect(everyone.events.map(({ cursor }) => cursor)).toEqual([cursorOf(1), cursorOf(4)])
    expect(first.events[0]).toMatchObject({ name: 'conversation.updated', data: { chat: '20', topic: '2' } })
    expect(() => page(db, { ...query, grant: 'k1', cursor: cursorOf(9) })).toThrow(
      expect.objectContaining({ reason: 'event_cursor' }),
    )
  })

  it('prunes what passed its retention, and a cursor before the floor is truncated', () => {
    const { db } = setup()
    record(db, wake('20', 2, { entry: 1 }, NOW - PUBLISH_LIMITS.retentionMs - 1))
    record(db, wake('20', 2, { entry: 2 }))
    pruneJournal(db, NOW)
    const polled = page(db, {
      grant: 'k1',
      name: 'conversation.updated',
      cursor: cursorOf(0),
      maxEvents: 10,
      cutoff: 0,
    })
    expect(polled).toMatchObject({ truncated: true, events: [expect.objectContaining({ cursor: cursorOf(2) })] })
    expect(behind(db, cursorOf(0))).toBe(true)
    expect(behind(db, cursorOf(1))).toBe(false)
  })

  it('journals only while someone listens: a running lease, or a poll within the retention', () => {
    const { db } = setup()
    expect(listened(db, NOW)).toBe(false)
    notePoll(db, NOW)
    expect(listened(db, NOW + 1000)).toBe(true)
    expect(listened(db, NOW + PUBLISH_LIMITS.retentionMs + 1)).toBe(false)
    lease(db, 'all-k1', 'key:k1')
    expect(listened(db, NOW + PUBLISH_LIMITS.retentionMs + 1)).toBe(false)
    expect(listened(db, NOW + 1000)).toBe(true)
  })
})

describe('deliveries owed to a lease', () => {
  it('give up on a wake for one gap before the oldest owed, a failing lease, and active again once one arrives', () => {
    const { db, sqlite } = setup()
    lease(db, 'all-k1', 'key:k1')
    const first = record(db, wake('20', 2))
    record(db, wake('21', 2))
    const claimed = claimDue(db, NOW, 'drain-1', 10)
    expect(claimed).toHaveLength(2)
    const [twenty, twentyOne] = claimed
    if (twenty === undefined || twentyOne === undefined) throw new Error('not claimed')
    settle(db, twenty, 'drain-1', { state: 'abandoned', atMs: NOW, reason: 'http_5xx' }, NOW)
    const [gap] = owed(sqlite, 'all-k1')
    expect(owed(sqlite, 'all-k1')).toHaveLength(1)
    expect(gap).toMatchObject({ kind: 'gap' })
    expect(JSON.parse(String(gap?.['body']))).toEqual({ type: 'gap', cursor: cursorOf((first?.seq ?? 0) - 1) })
    expect(leaseOf(db, 'all-k1')).toMatchObject({ status: 'failing', lastError: 'http_5xx' })
    // The other wake's late answer is fenced: its row is gone.
    settle(db, twentyOne, 'drain-1', { state: 'accepted', atMs: NOW }, NOW)
    expect(owed(sqlite, 'all-k1')).toHaveLength(1)
    // A failing lease is owed no new wakes; its gap arriving makes it active again.
    expect(record(db, wake('20', 2, { activity: 'idle' }))?.queued).toBe(0)
    const [control] = claimDue(db, NOW, 'drain-2', 10)
    if (control === undefined) throw new Error('no gap claimed')
    settle(db, control, 'drain-2', { state: 'accepted', atMs: NOW }, NOW)
    expect(leaseOf(db, 'all-k1')).toMatchObject({ status: 'active', lastError: null })
  })

  it('end with a terminated control when their holder’s access ends or the lease runs out; a renewal starts over', () => {
    const { db, sqlite } = setup()
    lease(db, 'all-k1', 'key:k1')
    lease(db, 'chat-20', 'key:k1', { chat: '20' })
    lease(db, 'client', 'client:c1:u1')
    record(db, wake('20', 2))
    expect(leaseCounts(db, 'key:k1', NOW, 'none')).toEqual({ holder: 2, workspace: 3 })
    expect(endHolder(db, 'key:k1', NOW)).toBe(2)
    expect(leaseCounts(db, 'key:k1', NOW, 'none')).toEqual({ holder: 0, workspace: 1 })
    const ended = owed(sqlite, 'all-k1')
    expect(ended).toEqual([expect.objectContaining({ kind: 'terminated' })])
    expect(JSON.parse(String(ended[0]?.['body']))).toEqual({
      type: 'terminated',
      error: { code: -32012, message: 'Access ended' },
    })
    // Subscribing again before the control went out drops it, so delivering it cannot end the new lease.
    lease(db, 'chat-20', 'key:k1', { chat: '20' })
    expect(owed(sqlite, 'chat-20')).toEqual([])
    const controls = claimDue(db, NOW, 'drain-1', 10).filter(({ kind }) => kind === 'terminated')
    expect(controls.map(({ subscriptionId }) => subscriptionId)).toEqual(['all-k1'])
    for (const control of controls) settle(db, control, 'drain-1', { state: 'accepted', atMs: NOW }, NOW)
    expect(leaseOf(db, 'all-k1')).toBeUndefined()
    expect(leaseOf(db, 'chat-20')?.status).toBe('active')
    // A lease not renewed before its end ends too.
    expect(nextDue(db)).toBeLessThanOrEqual(NOW + 3_600_000)
    expect(endExpired(db, NOW + 3_600_000)).toBe(2)
    expect(JSON.parse(String(owed(sqlite, 'client').at(-1)?.['body']))).toMatchObject({
      type: 'terminated',
      error: { code: -32011 },
    })
  })
})
