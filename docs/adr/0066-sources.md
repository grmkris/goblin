# 0066: Sources

Accepted 2026-10-15 with the owner. Supersedes ADR 0009 (Telegram through myagent) and ADR 0055 (Telegram routing)
once the channel goes (P7); amends ADR 0011 (MCP Events), ADR 0041 (Connections, Tell me and Hand to) and the root rule
on remote content. Part of the cleanup that makes goblin MCP-first, with no server-specific code (ADR 0063).

## Context

Telegram is goblin's one way for the owner to talk to their agent from outside the app, and it is special: a 2,400-line
channel built on one server's tool and Event names (mygram's `inbox_read`, `message_send`, `chat.changed`, reached
directly or through mysi). The owner wants no special handling for any server: connect any MCP server that emits events
(mygram for Telegram, a Slack server, a mail server), see what it can emit, and decide on goblin's side which messages
are their own turns, where they go and how goblin's answer goes back. MCP Events already exist (ADR 0011), and an event
descriptor already carries suggestions under `_meta.suggest` (ADR 0041).

The hard part is trust. A server's event is untrusted data (the root rule): it never becomes an instruction. A message
the owner writes in their own chat is the owner's turn. goblin cannot tell the two apart by itself; the server can say
it (`from.isOwner`), and only the owner can decide to believe it.

## Decision

**A Source is an owner-confirmed setup of five facts on one connection, and a route for each conversation.**

1. **Wake**: the event that says new content exists (`{ event, arguments }`).
2. **Key**: how a message's conversation is named: named RFC 6901 pointers into the message (`chat: /chat`,
   `thread: /threadId`).
3. **Speaks for me**: which messages are the owner speaking: all of them, or those whose value at a pointer equals a
   value (`/from/isOwner` is `true`); anyone else's message is an untrusted notice to the owner, or dropped (`others`).
4. **Read**: where the content is: the event's data (`items`, `id`, `text` and `direction` pointers), or a tool called
   from a cursor (an inbox read), its arguments a template.
5. **Reply** (optional): the tool goblin's answer goes back with, its arguments a template, cut to `maxChars`.

A conversation seen for the first time takes the setup's `newKeys`: held until the owner routes it (the default) or a
route. A **route** sends one conversation's owner messages to a Topic answered by goblin, to a Persona answering in a
Topic, to a Topic as notes with no turn (`listen`), nowhere (`ignore`), or holds them (the twenty newest, delivered in
order once it has a route, with an Activity offer).

**Templates fill whole values only.** An argument template's string value may be exactly `"{{key.<name>}}"`,
`"{{text}}"`, `"{{operationId}}"` or, for a read, `"{{cursor}}"`; goblin never puts text inside a string, so a message
cannot write into another argument. Pointers are checked against the event's `payloadSchema` and the read tool's
output schema when the server gives them: a pointer the schema says is not there is refused before the owner sees it.

**The server suggests, the agent proposes, the owner confirms.** A server may suggest a setup on an event
(`_meta.suggest.source`, read leniently, field by field). Otherwise the agent proposes one with `source_propose` from
the event's payload schema, the tools' schemas and the server's skills. Either way the owner reviews the exact revision
on a card (in the chat, and on the connection's card) and confirms or refuses it. Nothing runs before.

**Confirming binds the Source.** The confirmation grants the wake event's exact selector and the read and reply tools
(the owner confirmed them), subscribes the event under the consumer `source:<id>`, starts a tool read at the end of
what is there, and binds the Source to the connection's endpoint and a digest of its tools' grants. A Source whose
endpoint or grants changed since pauses for the owner's review. One whose subscription the server ended is subscribed
again while its binding holds; one that cannot be pauses for review too. The connection that carries the Telegram
channel cannot carry a Source until the channel is turned off.

**A server's structural claim decides which messages are owner turns, and nothing else.** A message matching the
speaks-for-me rule the owner confirmed is the owner's turn in the route's Topic, admitted like any owner turn (within
usage, under the chat's lock, on the owner's model). Everything else from the server, a matching message's words
included, stays untrusted data: it never grants anything, never changes a route or a setup, and never becomes an
instruction to goblin beyond being the owner's message. **Source turns get no extra authority**: a Topic's setup bounds
them as it bounds the web app's, grants still apply, and Ask-first tools still ask. The reply is goblin's own call
under the owner's grant of the reply tool; a reply tool set to Ask first refuses it, and the answer is given up.

**Answers go back once.** When the turn settles, its answer (goblin's, or the Persona's) goes out through the reply
tool, cut to `maxChars`, each piece under its own operation id derived from the turn's, so a retry never sends a piece
twice to a server that honours operation ids. A failed send is tried again with backoff and given up after five tries
with a notice to the owner; an answer still running after a day is given up.

**Routes are organizing.** The owner changes a route in the route table or from Activity's offer; the agent does it
only on the owner's direct request (`source_route`). Each change leaves an organizing receipt (`source.route`) with Undo
while nothing touched the route since (ADR 0033).

**Notify me via.** A separate owner setting names one connection's tool, with a template using `{{text}}` and
`{{operationId}}`, to copy goblin's notices to the owner elsewhere (their own chat). Settings has a shortcut that
copies a confirmed Source's reply template with one of its conversations filled in. The routine notices' Telegram copy
moves to it when the channel goes (P7).

## Consequences

- Telegram is one Source among others once P7 deletes the channel; until then both exist side by side, and a
  connection carries one or the other.
- Listen notes are passive `app.source` entries; notices from others are `app.notice` entries counted into the Source's
  hour (twenty an hour; the rest are kept for Activity).
- The run ledger records a Source's messages in and answers out as `channel.received` and `channel.reply` with channel
  `source`, and its flows as `source` and `source_delivery`, with ids and counts only (ADR 0024).
- Messages that came while a Source was paused are not taken when it resumes: it is bound again from now.
- A server whose payload schema says nothing lets any pointer through; the owner's review is then the only check.

## Rejected

- **Server-specific adapters** (a Telegram one, a Slack one): the code ADR 0063 removes.
- **Trusting a server's suggestion as confirmed**: a suggestion pre-fills the review; only the owner's confirmation of
  the exact revision binds a Source.
- **Interpolating text into templates**: a message could then shape another argument; whole-value placeholders cannot.
- **Routes as routines** (ADR 0041, amended 2026-10-13): a route hands no work over and has no instruction or budget; it
  is a conversation that answers back in place.
