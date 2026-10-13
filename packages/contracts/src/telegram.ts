// Telegram chats routed to Topics (ADR 0055): every chat and forum topic mygram relays, where goblin puts its messages
// and who answers them there. mygram names a chat `dm` (the owner's private chat with the bot) or by an opaque group
// handle; goblin never sees a raw Telegram id.
import * as Schema from 'effect/Schema'
import { PersonaId, TopicId } from './ids.ts'
import { TopicName } from './topics.ts'

/**
 * A Telegram chat as mygram names it: `dm`, the owner's private chat with the bot, or an opaque group handle (`g_` and
 * up to 64 letters and digits), stable across a supergroup migration.
 */
export const TelegramChatHandle = Schema.String.check(Schema.isPattern(/^(?:dm|g_[A-Za-z0-9]{1,64})$/u))
export type TelegramChatHandle = typeof TelegramChatHandle.Type

/** The owner's private chat with the bot. */
export const TELEGRAM_DM = 'dm'

/** A forum topic of a chat by its Telegram thread id; 0 is the chat itself (its General topic, or a chat without). */
export const TelegramThread = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }))
export type TelegramThread = typeof TelegramThread.Type

/** What kind of chat it is, as Telegram says: the owner's private chat, a group or a supergroup. */
export const TelegramChatKind = Schema.Literals(['private', 'group', 'supergroup'])
export type TelegramChatKind = typeof TelegramChatKind.Type

/**
 * Where a chat stands for goblin: `pending` waits for the owner to choose a route (its messages are held), `routed`
 * has one, `paused` and `left` are chats the bot was removed from or left (nothing is sent there).
 */
export const TelegramChatStatus = Schema.Literals(['pending', 'routed', 'paused', 'left'])
export type TelegramChatStatus = typeof TelegramChatStatus.Type

/**
 * A chat's route: its messages become turns in a Topic, answered by goblin or a Persona back in the same place
 * (`answer`); they are kept in the Topic with no turn (`listen`); or they are dropped (`ignore`).
 */
export const TelegramRoute = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('answer'), topic: TopicId, persona: Schema.optional(PersonaId) }),
  Schema.Struct({ mode: Schema.Literal('listen'), topic: TopicId }),
  Schema.Struct({ mode: Schema.Literal('ignore') }),
])
export type TelegramRoute = typeof TelegramRoute.Type

/** What goblin does with a chat it has not seen before: ask the owner in the DM, give it a new Topic, or Personal. */
export const NewChatsDefault = Schema.Literals(['ask', 'topic', 'personal'])
export type NewChatsDefault = typeof NewChatsDefault.Type

/**
 * How far the connection's grant reaches: the DM only, or every chat of the bot (`all`, the owner's "All chats" on
 * mysi's consent screen).
 */
export const TelegramReach = Schema.Literals(['dm', 'all'])
export type TelegramReach = typeof TelegramReach.Type

/**
 * One chat or forum topic in the Chats list. `thread` 0 is the chat; a topic row names its chat's title in
 * `chatTitle`. `route` is absent while the chat is pending, and for a topic that follows its chat's route
 * (`inherited` is then that route). `held` counts the messages waiting for the owner's choice (at most 20 a chat);
 * `offer` is true while goblin's question about it is open in the DM. `listed` is false for a chat `chat_list` no
 * longer names. Times are epoch seconds; `revision` counts route changes, so Undo can tell whether anything touched it.
 */
export const TelegramChat = Schema.Struct({
  chat: TelegramChatHandle,
  thread: TelegramThread,
  title: Schema.String,
  chatTitle: Schema.optional(Schema.String),
  kind: TelegramChatKind,
  isForum: Schema.optional(Schema.Boolean),
  status: TelegramChatStatus,
  route: Schema.optional(TelegramRoute),
  inherited: Schema.optional(TelegramRoute),
  held: Schema.Int,
  offer: Schema.Boolean,
  listed: Schema.Boolean,
  updatedBy: Schema.optional(Schema.Literals(['owner', 'agent'])),
  updatedAt: Schema.optional(Schema.Number),
  revision: Schema.Int,
})
export type TelegramChat = typeof TelegramChat.Type

/**
 * `GET /api/agent/channel/chats`: every chat the grant reaches (`chat_list`) merged with goblin's routes, what waits and
 * the open offers; the DM first. `reach` is `dm` when the grant sees only the DM, with `widenUrl` to let goblin see
 * the owner's groups. `synced` is false when `chat_list` could not be read now (the rows are then goblin's own).
 */
export const TelegramChats = Schema.Struct({
  reach: TelegramReach,
  widenUrl: Schema.optional(Schema.String),
  newChats: NewChatsDefault,
  synced: Schema.Boolean,
  chats: Schema.Array(TelegramChat),
})
export type TelegramChats = typeof TelegramChats.Type

/** A route as the owner (or the agent) picks it; `inherit` makes a forum topic follow its chat. */
export const RouteMode = Schema.Literals(['answer', 'listen', 'ignore', 'inherit'])
export type RouteMode = typeof RouteMode.Type

/**
 * `PUT /api/agent/channel/routes`: where a chat (`thread` 0 or absent) or one of its forum topics goes. `answer` and
 * `listen` name an existing Topic (`topic`) or a new one to make (`newTopic`, its name); `persona` makes a Persona
 * answer instead of goblin (`answer` only). `ignore` and `inherit` name neither, and `inherit` is for a topic only.
 * Picking a route answers goblin's open offer for it and delivers what was held, in order.
 */
export const RoutePick = Schema.Struct({
  chat: TelegramChatHandle,
  thread: Schema.optionalKey(TelegramThread),
  mode: RouteMode,
  topic: Schema.optionalKey(TopicId),
  newTopic: Schema.optionalKey(TopicName),
  persona: Schema.optionalKey(PersonaId),
}).check(
  Schema.makeFilter((pick) => {
    const places = (pick.topic === undefined ? 0 : 1) + (pick.newTopic === undefined ? 0 : 1)
    if (pick.mode === 'answer' || pick.mode === 'listen') {
      if (places !== 1) return 'Name one Topic: topic or newTopic.'
    } else if (places !== 0) return `${pick.mode} goes to no Topic.`
    if (pick.persona !== undefined && pick.mode !== 'answer') return 'Only an answering route has a Persona.'
    if (pick.mode === 'inherit' && (pick.thread ?? 0) === 0) return 'Only a forum topic follows its chat.'
    return true
  }),
)
export type RoutePick = typeof RoutePick.Type

/** `PUT /api/agent/channel/settings`: what goblin does with a chat it has not seen before. */
export const TelegramSettings = Schema.Struct({ newChats: NewChatsDefault })
export type TelegramSettings = typeof TelegramSettings.Type
