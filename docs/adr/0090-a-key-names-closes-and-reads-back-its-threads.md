# ADR 0090: A key names, closes and reads back its threads

Status: Accepted. Amends ADR 0081 (`conversations.update` joins the `conversations` scope, and the forward read
includes a message to Personas) and ADR 0086 (the `conversation_update` tool).

A server that gives each customer a Topic starts a thread under its Conversation for each customer and agent, and each
job, with the "+" anchor (`empty`). Those threads stayed "New thread": a thread is named by the memory model from a
user and assistant exchange, and a server's threads hold only Persona tags and answers. Its Topic's Conversation never
learned of them either: a "+" thread announces itself (`app.thread_started`) only from its own agent's response hook.
A key could not close a finished job's thread, since `conversations.update` reached no caller. And the forward read
showed a Persona's answer without the message it answered: a message that tags Personas is written as
`app.persona_ask`, which the read left out.

## Decision

- **A thread operation may name its thread.** `StartThread` takes an optional `title`. The thread is named before its
  first message; one started `empty` then writes its announcement into its Topic's Conversation in the same operation.
  A replay finds the same thread and writes no second note (the note is owed once and keyed `thread-started:<thread>`).
  Other anchors only take the title.
- **Naming announces an owed thread.** Any rename of a thread whose note is still owed, the owner's or a caller's,
  writes it, once (`announceNamed`).
- **A caller renames, closes and reopens.** `conversations.update` carries `EndpointScope` `conversations`, confined
  like the other conversation endpoints: a key reaches only its own Topics' chats. A key may set `title` and `closed`;
  `keepOpen` (pinning a subagent open) stays the owner's (`Forbidden` `key_keep_open`). A Topic's Conversation and main
  are still never renamed or closed (`topic_conversation`, `main_thread`). Closing stops the work under the thread,
  as the owner's close does, and the thread stays readable; a send to it is refused (`conversation_closed`) until it
  is reopened. On `/mcp` it is `conversation_update` `{ chat, change: { title?, closed?, keepOpen? } }`.
- **The forward read includes a message to Personas.** `app.persona_ask` reads as the owner's `message`, without the
  `[to @…]` prefix the model reads, with `to`, the Personas it went to (`{ id, name }`), and its author when it came
  from elsewhere.

A key's rename and close are still recorded as the owner's (`actor: 'owner'`); who acts in a forward is ADR 0089's.

## Consequences

- A server's threads carry its names in the sidebar and the channel, and it can tidy them up when a job ends.
- Not done: naming threads that only Personas answered, and any change to the announcement's wording.
