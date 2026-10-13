// The server's chat list read into goblin's routes (ADR 0055): titles, kinds, forum flags and whether the bot is in each
// chat, and the forum topics of each forum. A chat or topic seen here for the first time is new to goblin.
import { TelegramChatHandle, TelegramChatKind } from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { markListed, routeRow, seeChat, setPresence } from './routes.ts'
import type { ChannelCall } from './tools.ts'

const isHandle = Schema.is(TelegramChatHandle)
const isKind = Schema.is(TelegramChatKind)

/** `chat_list`: the chats the grant reaches, each with its title, kind and status (untrusted titles). */
const ChatList = Schema.Struct({
  chats: Schema.Array(
    Schema.Struct({
      chat: Schema.String,
      title: Schema.String,
      kind: Schema.String,
      status: Schema.String,
      isForum: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  ),
})
/** `thread_list`: a chat's forum topics, the bot's own and the ones it has seen, named when it knows (untrusted). */
const ThreadList = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({ threadId: Schema.Number, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})
const decodeChats = Schema.decodeUnknownOption(ChatList)
const decodeThreads = Schema.decodeUnknownOption(ThreadList)

/** A chat's kind as mygram says it, `group` when it says something else. */
const kindOf = (kind: string): TelegramChatKind => (isKind(kind) ? kind : 'group')

/** How the bot stands in a chat as mygram says it; none for a chat the owner has not claimed yet. */
const presenceOf = (status: string) =>
  status === 'active' || status === 'paused' || status === 'left' ? status : undefined

/** A chat or topic goblin saw for the first time in the server's lists. */
export type Discovered = { readonly chat: string; readonly thread: number }

/** One chat as the server lists it. */
type Listed = (typeof ChatList.Type)['chats'][number]

/** One listed chat into the routes; whether it is new to goblin and the bot is in it. */
function seeListed(db: DrizzleSqliteDODatabase, each: Listed, now: number): boolean {
  const isForum = each.isForum ?? undefined
  const kind = kindOf(each.kind)
  const seen = seeChat(
    db,
    { chat: each.chat, thread: 0, title: each.title, kind, ...(isForum === undefined ? {} : { isForum }) },
    now,
  )
  const presence = presenceOf(each.status)
  if (presence !== undefined) setPresence(db, each.chat, presence, now)
  return seen.created && presence === 'active'
}

type ListedTopic = (typeof ThreadList.Type)['threads'][number]

/** One listed forum topic into the routes, as new to goblin or not; one the server cannot name keeps the name it has. */
function seeTopic(db: DrizzleSqliteDODatabase, each: Listed, topic: ListedTopic, now: number): Discovered[] {
  const { threadId, name } = topic
  if ((name === undefined || name === null) && routeRow(db, each.chat, threadId) !== undefined) return []
  const title = name ?? `Topic ${String(threadId)}`
  const seen = seeChat(db, { chat: each.chat, thread: threadId, title, kind: kindOf(each.kind) }, now)
  return seen.created ? [{ chat: each.chat, thread: threadId }] : []
}

/** A forum's topics into the routes, as the server lists them; the ones new to goblin. */
const seeTopics = (db: DrizzleSqliteDODatabase, call: ChannelCall, each: Listed, now: number) =>
  Effect.gen(function* () {
    const threads = Option.flatMap(yield* Effect.option(call('threads', { chat: each.chat })), decodeThreads)
    const listed = Option.match(threads, { onNone: () => [], onSome: ({ threads: all }) => all })
    return listed
      .filter(({ threadId }) => Number.isSafeInteger(threadId) && threadId > 0)
      .flatMap((topic) => seeTopic(db, each, topic, now))
  })

/**
 * Reads the server's chat list and every forum's topics into the routes: new chats wait for the owner, known ones take
 * their titles and whether the bot is in them, chats the list no longer names are marked. The chats and topics that
 * were new and active; `synced` false when the chat list could not be read.
 */
export const syncChats = (db: DrizzleSqliteDODatabase, call: ChannelCall, now: number) =>
  Effect.gen(function* () {
    const chats = Option.flatMap(yield* Effect.option(call('chats', {})), decodeChats)
    if (Option.isNone(chats)) return { synced: false, discovered: [] satisfies Discovered[] }
    const valid = chats.value.chats.filter((each) => isHandle(each.chat))
    const discovered: Discovered[] = valid
      .filter((each) => seeListed(db, each, now))
      .map(({ chat }) => ({ chat, thread: 0 }))
    markListed(
      db,
      valid.map(({ chat }) => chat),
    )
    for (const each of valid.filter((chat) => chat.isForum === true))
      discovered.push(...(yield* seeTopics(db, call, each, now)))
    return { synced: true, discovered }
  })
