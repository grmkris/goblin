import { afterEach, describe, expect, it } from 'vitest'
import {
  RECEIPT_RETENTION,
  admitReceipt,
  advanceReceipt,
  receiptIn,
  receiptOf,
  receiptPowers,
  relatedReceipts,
} from '../src/chats/receipts.ts'
import { powerOfAll, senderPower } from '../src/grants/power.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const database = () => {
  const opened = chatDatabase()
  cleanups.push(opened.close)
  return opened
}

const send = { kind: 'send', origin: 'owner' } as const

describe('chat operation receipts (unit)', () => {
  it('refuses to read a row with no kind or state of its own: every admission writes both', () => {
    const { db, sqlite } = database()
    sqlite.exec(
      "INSERT INTO app_chat_operations (chat_id, operation_id, session_id, admitted_at) VALUES ('1', 'bare', '41', 10)",
    )
    expect(() => receiptOf(db, 'bare')).toThrow(expect.objectContaining({ _tag: 'Internal' }))
    expect(() => receiptIn(db, '1', 'bare')).toThrow(expect.objectContaining({ _tag: 'Internal' }))
  })

  it('records what an operation is before Pi sees it, and a replay finds its first receipt and session', () => {
    const { db } = database()
    const start = { kind: 'start', origin: 'owner', targetChat: '7' } as const
    expect(admitReceipt(db, { chat: '1', operationId: 'op', receipt: start, session: () => '41', now: 10 })).toEqual({
      session: '41',
      existing: false,
    })
    expect(admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '43', now: 12 })).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptIn(db, '1', 'op')).toEqual({
      chat: '1',
      operationId: 'op',
      session: '41',
      admittedAt: 10,
      kind: 'start',
      origin: 'owner',
      targetChat: '7',
      state: 'admitted',
    })
    expect(receiptIn(db, '2', 'op')).toBeUndefined()
  })

  it('moves a receipt on, stamping when it ended, and finds what an operation led to', () => {
    const { db } = database()
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '41', now: 10 })
    const first = { kind: 'send', origin: 'owner', parentOp: 'op' } as const
    admitReceipt(db, { chat: '7', operationId: 'op:first', receipt: first, session: () => '47', now: 11 })
    advanceReceipt(db, '1', 'op', { state: 'submitted', now: 12 })
    expect(receiptIn(db, '1', 'op')).toMatchObject({ state: 'submitted' })
    expect(receiptIn(db, '1', 'op')).not.toHaveProperty('settledAt')
    advanceReceipt(db, '7', 'op:first', { state: 'refused', reason: 'conversation_closed', now: 13 })
    expect(receiptIn(db, '7', 'op:first')).toMatchObject({
      state: 'refused',
      reason: 'conversation_closed',
      settledAt: 13,
    })
    expect(relatedReceipts(db, 'op').map((receipt) => receipt.operationId)).toEqual(['op:first'])
  })

  it('finds an operation admitted in two chats by its first receipt', () => {
    const { db } = database()
    admitReceipt(db, { chat: '2', operationId: 'op', receipt: send, session: () => '42', now: 20 })
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '41', now: 10 })
    expect(receiptOf(db, 'op')).toMatchObject({ chat: '1', session: '41' })
    expect(receiptOf(db, 'missing')).toBeUndefined()
  })

  it('drops receipts past the retention, but never the one being replayed', () => {
    const { db } = database()
    admitReceipt(db, { chat: '1', operationId: 'old', receipt: send, session: () => '41', now: 1 })
    admitReceipt(db, { chat: '1', operationId: 'retry', receipt: send, session: () => '41', now: 1 })
    const now = 2 + RECEIPT_RETENTION
    expect(admitReceipt(db, { chat: '1', operationId: 'retry', receipt: send, session: () => '43', now })).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptOf(db, 'old')).toBeUndefined()
  })

  it("keeps the role of the member who asked, and finds a member's operation in any chat (ADR 0099)", () => {
    const { db } = database()
    admitReceipt(db, {
      chat: '1',
      operationId: 'mine',
      receipt: { ...send, role: 'owner' },
      session: () => '41',
      now: 1,
    })
    admitReceipt(db, {
      chat: '1',
      operationId: 'source',
      receipt: { kind: 'source', origin: 'source' },
      session: () => '41',
      now: 1,
    })
    admitReceipt(db, {
      chat: '7',
      operationId: 'theirs',
      receipt: { ...send, role: 'member' },
      session: () => '47',
      now: 1,
    })
    expect(receiptIn(db, '1', 'mine')).toMatchObject({ role: 'owner' })
    expect(receiptIn(db, '1', 'source')).not.toHaveProperty('role')
    expect(receiptOf(db, 'theirs')).toMatchObject({ chat: '7', role: 'member' })
    // A receipt made before powers were reads as its role says, and work no person sent as an admin's (ADR 0115).
    expect(receiptPowers(db, [])).toEqual([])
    expect(powerOfAll(receiptPowers(db, ['mine', 'source', 'missing']))).toMatchObject({ level: 'manage' })
    expect(powerOfAll(receiptPowers(db, ['mine', 'theirs']))).toMatchObject({ level: 'write', extras: ['inspect'] })
  })

  it('keeps the power of whoever admitted an operation, and narrows it when someone who may do less replays it', () => {
    const { db } = database()
    const key = senderPower({
      kind: 'key',
      grant: { grantId: 'key-1', level: 'write', extras: [], topics: 'list', connections: 'all' },
    })
    const owner = senderPower({ kind: 'person', role: 'owner' })
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: { ...send, power: owner }, session: () => '41', now: 1 })
    expect(receiptIn(db, '1', 'op')?.power).toEqual(owner)
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: { ...send, power: key }, session: () => '41', now: 2 })
    expect(receiptPowers(db, ['op'])).toEqual([
      { level: 'write', extras: [], server: true, topicLists: ['key-1'], connectionLists: [] },
    ])
  })

  it("marks an operation a member replays as theirs, and never unmarks a member's", () => {
    const { db, sqlite } = database()
    const member = { ...send, role: 'member' } as const
    admitReceipt(db, { chat: '1', operationId: 'reused', receipt: send, session: () => '41', now: 1 })
    expect(powerOfAll(receiptPowers(db, ['reused'])).level).toBe('manage')
    expect(
      admitReceipt(db, { chat: '1', operationId: 'reused', receipt: member, session: () => '43', now: 2 }),
    ).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptIn(db, '1', 'reused')).toMatchObject({ role: 'member', admittedAt: 1 })
    admitReceipt(db, {
      chat: '1',
      operationId: 'reused',
      receipt: { ...send, role: 'owner' },
      session: () => '41',
      now: 3,
    })
    expect(powerOfAll(receiptPowers(db, ['reused']))).toMatchObject({ level: 'write', extras: ['inspect'] })
    expect(() => sqlite.exec("UPDATE app_chat_operations SET role = 'guest'")).toThrow(/CHECK/u)
  })
})
