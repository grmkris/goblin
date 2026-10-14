import { afterEach, describe, expect, it } from 'vitest'
import {
  allRoutes,
  closeOffer,
  dropHeld,
  effectiveRoute,
  heldCounts,
  heldOf,
  hold,
  markListed,
  offerOf,
  openOffer,
  release,
  routeRow,
  seeChat,
  setPresence,
  setRoute,
  takeDropped,
} from '../src/channel/routes.ts'
import { HELD_LIMIT } from '../src/sources/held.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const database = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  return durable(db)
}

const GROUP = 'g_trip0000000000000'
const trip = { chat: GROUP, thread: 0, title: 'Trip planning', kind: 'supergroup', isForum: true } as const

describe('Telegram routes (unit)', () => {
  it('routes the DM to Personal from the start, and makes a new group wait for the owner', () => {
    const db = database()
    expect(effectiveRoute(db, 'dm', 0)).toEqual({ mode: 'answer', topic: 1 })
    expect(seeChat(db, { chat: 'dm', thread: 0, title: 'Kris', kind: 'private' }, 1).row).toMatchObject({
      status: 'routed',
      mode: 'answer',
      topicId: 1,
    })
    const seen = seeChat(db, trip, 1)
    expect(seen).toMatchObject({ created: true, row: { status: 'pending', mode: null, listed: true } })
    expect(effectiveRoute(db, GROUP, 0)).toEqual({ mode: 'hold' })
    expect(seeChat(db, { ...trip, title: 'Trip 2027' }, 2)).toMatchObject({
      created: false,
      row: { title: 'Trip 2027', status: 'pending' },
    })
  })

  it("gives a forum topic its chat's route until it has its own, and inherit clears it again", () => {
    const db = database()
    seeChat(db, trip, 1)
    seeChat(db, { ...trip, thread: 7, title: 'Flights' }, 1)
    expect(effectiveRoute(db, GROUP, 7)).toEqual({ mode: 'hold' })
    const routed = setRoute(db, trip, { mode: 'answer', topic: 4, persona: 2 }, 'owner', 2)
    expect(routed?.after).toMatchObject({ status: 'routed', revision: 1, updatedBy: 'owner', personaId: 2 })
    expect(effectiveRoute(db, GROUP, 7)).toEqual({ mode: 'answer', topic: 4, persona: 2 })
    setRoute(db, { chat: GROUP, thread: 7 }, { mode: 'listen', topic: 5 }, 'agent', 3)
    expect(effectiveRoute(db, GROUP, 7)).toEqual({ mode: 'listen', topic: 5 })
    setRoute(db, { chat: GROUP, thread: 7 }, { mode: 'inherit' }, 'owner', 4)
    expect(effectiveRoute(db, GROUP, 7)).toEqual({ mode: 'answer', topic: 4, persona: 2 })
    setRoute(db, trip, { mode: 'ignore' }, 'owner', 5)
    expect(effectiveRoute(db, GROUP, 0)).toEqual({ mode: 'ignore' })
    expect(setRoute(db, { chat: 'g_unknown', thread: 0 }, { mode: 'ignore' }, 'owner', 5)).toBeUndefined()
  })

  it('keeps a paused chat paused through a route change, and pending again once back with no route', () => {
    const db = database()
    seeChat(db, trip, 1)
    setPresence(db, GROUP, 'paused', 2)
    expect(routeRow(db, GROUP, 0)?.status).toBe('paused')
    setPresence(db, GROUP, 'active', 3)
    expect(routeRow(db, GROUP, 0)?.status).toBe('pending')
    setPresence(db, GROUP, 'left', 4)
    setRoute(db, trip, { mode: 'answer', topic: 1 }, 'owner', 5)
    expect(routeRow(db, GROUP, 0)?.status).toBe('left')
    setPresence(db, GROUP, 'active', 6)
    expect(routeRow(db, GROUP, 0)?.status).toBe('routed')
  })

  it('finds an offer by its question until a route choice closes it', () => {
    const db = database()
    seeChat(db, trip, 1)
    openOffer(db, trip, 'q1')
    expect(offerOf(db, 'q1')).toMatchObject({ chat: GROUP, offer: 'open' })
    setRoute(db, trip, { mode: 'ignore' }, 'owner', 2)
    expect(offerOf(db, 'q1')).toMatchObject({ offer: 'closed' })
    seeChat(db, { ...trip, thread: 3, title: 'Hotels' }, 3)
    openOffer(db, { chat: GROUP, thread: 3 }, 'q2')
    closeOffer(db, { chat: GROUP, thread: 3 })
    expect(offerOf(db, 'q2')?.offer).toBe('closed')
  })

  it('holds the twenty newest messages of a waiting chat in order and counts the ones it dropped', () => {
    const db = database()
    seeChat(db, trip, 1)
    for (let index = 0; index < HELD_LIMIT + 3; index++)
      hold(db, { entryId: `m${index}`, chat: GROUP, thread: 0, text: `message ${index}`, trigger: 'mention' }, 1)
    hold(db, { entryId: 'm22', chat: GROUP, thread: 0, text: 'again', trigger: null }, 2)
    const held = heldOf(db, GROUP)
    expect(held.map(({ entryId }) => entryId)).toEqual(Array.from({ length: 20 }, (_, index) => `m${index + 3}`))
    expect(heldCounts(db).get(GROUP)).toBe(20)
    expect(takeDropped(db, GROUP)).toBe(3)
    expect(takeDropped(db, GROUP)).toBe(0)
    release(db, 'm3')
    expect(heldOf(db, GROUP)[0]?.entryId).toBe('m4')
    openOffer(db, trip, 'q1')
    dropHeld(db)
    expect(heldOf(db, GROUP)).toEqual([])
    expect(offerOf(db, 'q1')?.offer).toBe('closed')
  })

  it('lists the DM first and marks the chats the server no longer lists', () => {
    const db = database()
    seeChat(db, trip, 1)
    seeChat(db, { chat: 'dm', thread: 0, title: 'Kris', kind: 'private' }, 1)
    seeChat(db, { chat: 'g_aaaa', thread: 0, title: 'Book club', kind: 'group' }, 1)
    expect(allRoutes(db).map(({ chat }) => chat)).toEqual(['dm', 'g_aaaa', GROUP])
    markListed(db, ['dm', GROUP])
    expect(allRoutes(db).map(({ listed }) => listed)).toEqual([true, false, true])
    markListed(db, [])
    expect(allRoutes(db).every(({ listed }) => !listed)).toBe(true)
  })
})
