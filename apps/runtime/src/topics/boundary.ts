import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appConversations } from '../storage/schema.ts'
import { appTopics } from '../storage/topics.ts'

// Where a chat's work may reach (ADR 0115), as functions of the agent's database. Every Topic is sealed: its chats
// (its Conversation, threads, subagents, Persona forks and routine runs, all registered in the Topic their chain's root
// is in) see only that Topic. A hub's chats see every Topic of the workspace. Personal is the hub until an admin says
// otherwise. A boundary is a place, read live; what a turn may do inside it is its power's (`grants/power.ts`).

type Db<R = unknown> = SQLiteAsyncDatabase<'sync', R>

/** The Topic a chat works in, and whether that Topic is a hub, which reaches every Topic. */
export type Boundary = { readonly topic: number; readonly hub: boolean }

/** Whether work within `boundary` may reach Topic `topic`: the hub reaches every one, a sealed Topic itself alone. */
export const withinBoundary = (boundary: Boundary, topic: number): boolean => boundary.hub || boundary.topic === topic

/** Topic `topic`'s boundary, read live; none when there is no such Topic. */
export const topicBoundary = <R>(db: Db<R>, topic: number): Boundary | undefined => {
  const row = db.select({ reach: appTopics.reach }).from(appTopics).where(eq(appTopics.id, topic)).get()
  return row === undefined ? undefined : { topic, hub: row.reach === 'hub' }
}

/**
 * Registered chat `chat`'s boundary: its Topic's, which is its chain root's (a thread, a subagent and a Persona's fork
 * are registered in the Topic of the chat they came from). None for a chat the agent does not keep, which reaches
 * nothing.
 */
export const boundaryOf = <R>(db: Db<R>, chat: string): Boundary | undefined => {
  const row = db
    .select({ topic: appConversations.topicId })
    .from(appConversations)
    .where(eq(appConversations.chatId, chat))
    .get()
  return row === undefined ? undefined : topicBoundary(db, row.topic)
}
