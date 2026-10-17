import { EMPTY_SIDEBAR, MAX_PINS, type SidebarPins } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { editedSidebar, readSidebar, withoutServer, withoutView } from '../src/sidebar/store.ts'
import { chatDatabase } from './chats-sqlite.ts'

const wallet = { kind: 'server', connectionId: 'wallet' } as const
const board = { kind: 'view', appId: '7', title: 'Trip board' } as const

describe('sidebar pins (ADRs 0053, 0078, unit)', () => {
  it('pins only what the owner pins, last unless an index is given, a revision on', () => {
    const one = editedSidebar(EMPTY_SIDEBAR, { expectedRevision: 0, op: { kind: 'pin', pin: board } })
    expect(one).toEqual({ revision: 1, pins: [board] })
    const two = editedSidebar(one, { expectedRevision: 1, op: { kind: 'pin', pin: wallet, index: 0 } })
    expect(two).toEqual({ revision: 2, pins: [wallet, board] })
    expect(editedSidebar(two, { expectedRevision: 2, op: { kind: 'unpin', target: wallet } }).pins).toEqual([board])
  })

  it('moves a pin to an index of the list it is in, and pinning what is pinned moves it', () => {
    const start: SidebarPins = { revision: 2, pins: [wallet, board] }
    expect(editedSidebar(start, { expectedRevision: 2, op: { kind: 'move', target: board, index: 0 } }).pins).toEqual([
      board,
      wallet,
    ])
    expect(editedSidebar(start, { expectedRevision: 2, op: { kind: 'pin', pin: wallet } }).pins).toEqual([
      board,
      wallet,
    ])
  })

  it(`refuses a pin past ${MAX_PINS}`, () => {
    const full: SidebarPins = {
      revision: 0,
      pins: Array.from({ length: MAX_PINS }, (_, index) => ({ kind: 'server', connectionId: `s${index}` }) as const),
    }
    expect(() => editedSidebar(full, { expectedRevision: 0, op: { kind: 'pin', pin: board } })).toThrow()
  })

  it('takes a removed server’s pin and a deleted App’s view; nothing when neither was there', () => {
    const start: SidebarPins = { revision: 4, pins: [wallet, board] }
    expect(withoutServer(start, 'wallet')).toEqual({ revision: 5, pins: [board] })
    expect(withoutView(start, '7')).toEqual({ revision: 5, pins: [wallet] })
    expect(withoutServer(start, 'other')).toBeUndefined()
    expect(withoutView(start, '8')).toBeUndefined()
  })

  it('reads pins stored before servers stopped being pinned on their own, ignoring what they remembered', () => {
    const { db, sqlite, close } = chatDatabase()
    const stored = JSON.stringify({ revision: 3, pins: [wallet], seen: ['wallet', 'notes'] })
    sqlite.prepare('INSERT INTO app_sidebar (id, revision, pins) VALUES (1, 3, ?)').run(stored)
    expect(readSidebar(db)).toEqual({ revision: 3, pins: [wallet] })
    close()
  })
})
