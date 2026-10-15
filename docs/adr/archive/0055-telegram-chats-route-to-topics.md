# 0055: Telegram chats route to Topics

Accepted 2026-10-13 with the owner. It amends ADR 0009 (Telegram through one connection: the Events path only), ADR
0024 (observing conversations: groups are designed now), ADR 0032 (Topics: inbound is no longer Personal-only) and
ADR 0041 (Tell me, Hand to: a channel route is not a routine), and builds on ADRs 0033 (Personas and organizing
receipts), 0040 (a Topic's setup) and 0052 (one mysi connection, the names of an app's tools and Events).

## Context

mygram relays more than the owner's private chat with the bot now. Every inbox entry and Events payload names its
`chat`: `dm`, or an opaque group handle `g_…` that survives a supergroup migration; raw Telegram ids never reach an
agent. An entry also names its forum topic (`threadId`), how it reached the bot (`trigger`: a mention, a reply, a
command or an answer) and the question it answers (`questionId`). In a group, mygram stores only the owner's own
addressed messages and labels the agent's messages with the grant's name. A grant reaches the DM only, or every chat of
the bot ("All chats", `<bot>~all`), which the owner chooses on mysi's consent screen; widening it ends the client's
Events subscriptions. The old doorbell (`subscribe`/`unsubscribe`) is gone from mygram.

goblin read the DM only, turned every message into a turn in Personal and answered with no chat, so a group or a forum
topic could not reach the agent, and its answer could not go back to it.

## Decision

**Routes.** Each chat, and each forum topic of one, has a route (`app_telegram_routes`, keyed by the chat handle and
the thread, 0 for the chat itself): its messages become turns in a Topic, answered by goblin or by a Persona, back in
the same chat and topic (`answer`); they are kept in the Topic as notes with no turn (`listen`); or they are dropped
(`ignore`). A forum topic follows its chat's route until it has one of its own. The DM's own route is Personal,
answered by goblin, until the owner changes it. An archived Topic sends its messages to Personal, as a routine's home
does (ADR 0032).

**New chats wait for the owner.** A chat goblin sees for the first time (in the inbox, in the server's chat list, or
named by `chat.changed`) is `pending`: its messages are held (`app_telegram_held`, the twenty newest a chat; older ones
are counted and the count goes before the first one delivered), and goblin asks in the DM with buttons
(`question_ask`, operation `telegram-offer:<chat>:<thread>`): New topic #<title>, Personal, Ignore. A new forum topic of
a routed chat follows its chat at once, and goblin asks once: New topic #<name>, Same as the chat, Ignore. The answer
(the owner's tap, an answer entry carrying the question's id) sets the route and starts no turn; a late answer to a
closed offer is dropped. Activity shows the same offer. The owner may instead choose a default for new chats: a new
Topic named after the chat (operation `telegram:<chat>:<thread>`, the active Topic of that name when there is one) or
Personal. Held messages are delivered in order once their chat has a route.

**Answers go back in place.** A reply row (`app_channel_replies`) names the goblin chat the turn ran in, the Telegram
chat and topic it came from, and the Persona that answers it; the answer is goblin's in that chat or the Persona
invocation's. It goes out with `message_send { chat, threadId }`; an answer that stopped on one single-choice
`ask_user` goes out as `question_ask` buttons in the same chat and topic, and the owner's tap comes back as their reply:
goblin keeps each button's label with the reply and reads the pressed button from the server's question state
(`inbox_read { questionId }`), never from the answer entry's words, which are display text.
goblin never adds its own name: mygram labels group messages. A chat the bot was removed from (`chat_paused`,
`chat_left`) is marked so and takes no answers. Notices and an app's `notify` always go to the DM.

**Changing a route.** The owner changes routes in Connections, the mysi card's Telegram Chats list
(`GET /api/agent/channel/chats`, `PUT /api/agent/channel/routes`, `PUT /api/agent/channel/settings`), before a chat
ever writes ("before the fact") or after. goblin changes them on the owner's direct request with `telegram_chats` and
`telegram_route`. Each change goes through the channel, between pulls, and leaves an organizing receipt
(`telegram.route`, `telegram.default`) with Undo while nothing touched it since.

**One path in.** The channel is carried by Events only: `message.received`, `question.answered` and, once the server
offers it, `chat.changed`, subscribed with `{ chat: 'all' }` when the grant reaches every chat (a read of every chat
answers), and with `{}` otherwise, when goblin shows the owner the widen link the server's refusal carried ("Let
goblin see your groups"). The inbox is read with `{ chat: 'all' }` the same way, under one cursor. An ended
subscription (as after a widen) is subscribed again by the next pull, with the reach the grant has then; one
that cannot be (a revoked grant) marks the channel `ended` for the owner, once, instead of looping. `chat.changed`
and every Chats list read the server's chat list again: titles, kinds, forum flags and whether the bot is in a chat.
The doorbell and its hook route are gone.

## Consequences

- A group's answers are visible to its members. The owner chooses each route explicitly, mygram relays only the
  owner's own addressed messages, and every other entry (`out`, `archive`) is context, never an instruction.
- The route rows survive turning the channel off; held messages and open offers do not.
- Telemetry stays content-free: a routed message is recorded as before, under the chat it ran in.
- A chat whose handle goblin cannot read, or a raw Telegram id, is skipped.
