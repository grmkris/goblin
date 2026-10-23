import { afterEach, describe, expect, it } from 'vitest'
import { boundaryOf, topicBoundary, withinBoundary } from '../src/topics/boundary.ts'
import { chatDatabase } from './chats-sqlite.ts'

const open: (() => void)[] = []
afterEach(() => {
  for (const close of open.splice(0)) close()
})

/** Personal (1, the hub) with main; Customer (2) with its Conversation, a thread, a subagent of it and a Persona fork. */
function fixture() {
  const database = chatDatabase()
  open.push(database.close)
  database.sqlite.exec(`INSERT INTO app_topics (id, name, chat_id, created_by, created_at, updated_at) VALUES
    (2, 'Customer', '20', 'owner', 1, 1)`)
  database.sqlite
    .exec(`INSERT INTO app_conversations (session_id, pi_session, role, kind, title, parent_session, created_at, topic_id) VALUES
    ('1', '1', 'primary', 'main', NULL, NULL, 1, 1),
    ('20', '20', 'conversation', 'main', 'Customer', NULL, 1, 2),
    ('21', '21', NULL, 'thread', 'Order', '20', 1, 2),
    ('22', '22', NULL, 'subagent', 'scout', '21', 1, 2),
    ('23', '23', 'persona', 'thread', NULL, '20', 1, 2)`)
  return database
}

describe('the boundary a chat works within (ADR 0115)', () => {
  it("is its Topic's, from Personal the hub and from every chat under a sealed Topic", () => {
    const { db } = fixture()
    expect(boundaryOf(db, '1')).toEqual({ topic: 1, hub: true })
    for (const chat of ['20', '21', '22', '23']) expect(boundaryOf(db, chat), chat).toEqual({ topic: 2, hub: false })
    expect(boundaryOf(db, '99')).toBeUndefined()
    expect(topicBoundary(db, 9)).toBeUndefined()
  })

  it('follows the Topic live: a Topic made a hub reaches every Topic, a sealed Personal only itself', () => {
    const { db, sqlite } = fixture()
    sqlite.exec("UPDATE app_topics SET reach = 'hub' WHERE id = 2")
    sqlite.exec("UPDATE app_topics SET reach = 'sealed' WHERE id = 1")
    expect(boundaryOf(db, '21')).toEqual({ topic: 2, hub: true })
    expect(boundaryOf(db, '1')).toEqual({ topic: 1, hub: false })
  })

  it('reaches the Topic itself from a sealed one, and every Topic from a hub', () => {
    expect(withinBoundary({ topic: 2, hub: false }, 2)).toBe(true)
    expect(withinBoundary({ topic: 2, hub: false }, 3)).toBe(false)
    expect(withinBoundary({ topic: 1, hub: true }, 3)).toBe(true)
  })
})
