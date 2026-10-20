import type { TopicSetup } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { type SetupScope, chatScope, scopeOf } from '../src/setup/scope.ts'
import { Resident } from '../src/mcp/service.ts'
import { appConversations } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { storedSetup } from '../src/topics/setup.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

/** A resident authority method no fake caller reaches. */
const unused = () => Effect.die('resident authority: not used here')

/**
 * Resident authority as the owner gate and the programs use it (`Resident`), always current: `grants` holds the time
 * (epoch seconds) of each grant the gate asked for. Nothing that stands it in asks for its status or changes it.
 */
export const currentResident = () => {
  const grants: number[] = []
  const service = Resident.of({
    status: unused,
    grant: () =>
      Effect.map(Clock.currentTimeMillis, (millis) => {
        grants.push(Math.floor(millis / 1000))
      }),
    revoke: unused,
    enable: unused,
    require: () => Effect.void,
  })
  return { service, grants }
}

/** Fixed switches per conversation (everything on for any other): the tools only ask for a `scope`. */
export const fixedScopes =
  (scopes: Readonly<Record<string, SetupScope>>) =>
  (session: string): SetupScope =>
    scopes[session] ?? scopeOf([], true)

/**
 * The scope of a Topic's Conversation with nothing else narrowing it, as the agent reads it (`chatScope`) from a
 * database that holds the Topic with `setup`. The scope keeps what it read, so the database is closed again.
 */
export const topicChatScope = (topic: { readonly id: number; readonly name: string; readonly setup: TopicSetup }) => {
  const { db, close } = chatDatabase()
  try {
    const chatId = `topic-${topic.id}`
    db.insert(appTopics)
      .values({ ...topic, chatId, setup: storedSetup(topic.setup), createdBy: 'owner', createdAt: 1, updatedAt: 1 })
      .run()
    db.insert(appConversations)
      .values({ chatId, piSession: chatId, kind: 'main', role: 'conversation', topicId: topic.id, createdAt: 1 })
      .run()
    return chatScope(durable(db), chatId)
  } finally {
    close()
  }
}
