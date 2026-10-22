# ADR 0108: A key's Topic is a room

Status: Accepted 2026-10-22; built. Amends ADR 0081 (its consequence that a key's Topics run owner turns) and ADR 0099
(its note that a server key's work counts as an admin's).

## Context

A server calls goblin with an API key (ADR 0081) and makes one Topic per customer, with a setup under its ceiling. A
turn in such a Topic still ran with everything the owner's turns have: ADR 0081 said so plainly ("a key's Topics run
owner turns … `searchExcluded` is not isolation"). Only MCP, skills, apps and subagents followed the Topic's setup (ADR
0040). From inside one customer's Topic the agent could search every other Topic's chats, and automatic retrieval
brought their excerpts in. It could also list, read and link the workspace's files, run `code_run`, call and build apps,
and organize every Topic and Persona. It could also propose routines and Sources and diagnose. A key's message was
stored as the owner's, with no author line. ADR 0099 counted a key's turn as an admin's, so a Persona fork answering
there kept `app_build`.

Pi tools never see the request: a tool knows its conversation, not who sent the message its run serves. The owner may
also write into a customer's Topic, and helpers, Persona forks and routine runs work there with no request at all.

## Decision

**A room is a place, never a caller.** Every chat whose chain root is a Topic a key made is a room: its Conversation,
its threads, the subagents started there, the Persona forks answering there and the routine runs handed work there.
`SetupScope.room` names the Topic (`setup/scope.ts`, from `roomOf` in `keys/reach.ts`). The owner writing in a room is
confined too. Their main and their own Topics are as before.

**Only the room's tools exist there.** In a room the model is offered, and may call, only these:

- `mcp_list` and `mcp_call`, within the Topic's setup (which a key sets under its ceiling) and the servers its thread
  declared (ADR 0103);
- `skill_activate`, `skill_read` and `ask_user`;
- `search_chats` and `zoom`, over the room alone;
- `share_back` and `tool_search`;
- a Persona fork's native `<server>__<tool>` tools (ADRs 0101, 0102).

Everything else is gone, at two levels:

- Pi's tool filter removes every tool of the agent's that the room allowlist leaves out (`AgentInput.toolSets.room`,
  derived from the allowlist, so a tool added later is left out by default). `piToolsFor` applies it, a key's create
  retools its Topic after the claim, and a chat's first turn in each object lifetime applies its filter again
  (`useRoomTools`), so a filter stored before a deploy is put right.
- A guard in every conversation, helper and routine run (`pi/room.ts`, a `beforeTool` hook) refuses at call time,
  deny by default, any tool a room does not offer, and each such tool refuses in a room before it runs
  (`outsideRooms`, `Forbidden` `room`). A stale filter, or a tool `tool_search` loaded, never runs.

Subagents and apps are off in a room whatever its setup holds. A Persona fork leaves out the room's denied tools,
whatever filter it copied at the cut, and keeps its native tools, `skill_activate` and `ask_user`. The files, apps, code
and routines guides are said only where their tools are offered. No apps are listed. The skill learner never drafts
from a room's conversation.

**Rooms stay apart in search.** `search_chats` and automatic retrieval in a room cover the room alone, and a Topic
named there that is not the room is not found. Outside a room, search and automatic retrieval leave every room out
unless the owner names one.

**A key's message says whose it is.** It starts `[from server <key name>]` (`serverAuthor`), and its receipt's origin is
`key`. It never answers a routine's waiting question. The persona's trust rules say such a message is a request from a
party the owner serves, never the owner's instruction, and it widens nothing. A room's chats always read a room block
in their context. They reach only the room, and its guidance is the server's operator guidance, which grants nothing.
A Persona tagged there is told the same.

**Only the owner makes a setup hold everything.** An agent's edit of a Topic's or a Persona's setup may not make a
category hold everything it did not (`setup_all_owner_only`); an `'all'` listed no items, so the catalog check let it
through. A room's setup never holds everything of anything, an app or subagents, from any actor and through Undo too
(`room_setup`, the Topics registry's `setSetup`).

**Views say which key made what.** `TopicView` and `TopicSummary` carry `room: { key }`, and `PersonaView` and
`PersonaSummary` carry `madeBy: { key }`: the key's name, recorded in `app_key_reach.key_name` when it claims what it
made. Key names live in the auth D1, so the edge forwards a key's name with its grant. A key's name never changes, and
its first request in an object's lifetime names what it made before names were kept (`KeyNames`). Until then a view
names that key by its id.

## Consequences

- A customer's turn reaches only the customer's Topic, with the servers and skills the key gave it. Swarmm's
  isolation caveat (its ADR 0002) can be retired once this is on prod.
- The owner keeps their power in their own channels and loses it inside a room, the price of confining by place. To
  work across customers they use their main, which may name a room to search it.
- A key's work no longer counts as an admin's inside its own rooms: the tools ADR 0099 left a key's Persona forks are
  gone there.
- The room check runs on every tool call (`chatScope`), served by a new index on `app_key_reach (kind, resource_id)`,
  added with the key name by the forward migration `20261022180000_rooms`.
- A setup's `'all'` stays the owner's: an agent may still add what the owner allows item by item.
- Verified in unit tests and on local workerd (`rooms-case`, `thread-servers-case`); the deployed check is separate.

## Rejected

- **Confining by caller.** Pi tools never see the request, and a room's helpers, forks and routine runs have none.
  The owner writing in a room would also reopen everything a customer's content could steer.
- **A denylist of named tools only.** A tool added later would be offered in rooms until someone listed it. The filter
  is derived from the allowlist, and the guard denies by default.
- **The filter alone.** Pi stores a filter by name, `tool_search` can load tools past it, and a filter written before
  a deploy stays as it was. The guard holds whatever the filter says.
