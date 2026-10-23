# ADR 0113: A room runs in its own object

Status: Proposed 2026-10-22 (draft by swarmm-d5, reviewed by goblin-dc; for Kris). Builds on ADR 0108; follows ADRs 0110–0112.
Amends ADR 0003 (the agent object owns everything) and ADR 0089 (one object per workspace).

## Context

A workspace is one `PersonalAgent` object (`env.AGENTS.getByName(workspaceId)`). Every chat, Topic, Persona fork,
MCP connection, memory index, routine and ledger row lives in its SQLite. Every turn shares its one JavaScript thread,
its isolate's memory and its restarts.

A server that serves its own customers through a key (ADR 0081) puts every customer in that one object. Swarmm does
this with one Topic per customer. ADR 0108 made each such Topic a room, but the confinement is logical: rooms still
share one thread and one memory, and one deploy restarts all of them at once. A failure in one is a failure for all.

On 2026-10-22, ADR 0108's name backfill ran inside a key's first request after a restart, and every Swarmm prod read
waited 13 minutes. The backfill is fixed, but the shape that caused it remains: anything slow, large or crashing in
one room is felt in every room.

ADR 0108 already cut most of what a room shares with its workspace:
- no cross-room search or retrieval;
- no files, apps, code, routines, Sources or subagents;
- a Persona fork answers with a setup frozen at the ask.

So the room is the natural boundary for an object of its own.

Two facts constrain the split (from `origin/dev` 060f125c):

- **Pi has one id space per database.** Conversations, entries, tasks, submissions and documents share one counter
  (`pi-durable` `storage.js:92-131`). Forks and threads inherit history by reference (`parent.conversationId`,
  `parent.at`), and app tables keep entry ids (`fork_entry`, `answer_entry`, memory, transcript index, run ledger).
  **A room's chats cannot be moved to another database.** Only new rooms can start in their own object.
- **A chat id is a bare per-object integer** (`ChatId ^\d{1,12}$`). Whether a chat is in a room is known only from the
  workspace's SQLite (`topic_id`, then `app_key_reach`). Today the edge cannot route by room.

## Decision

**Every Topic a key makes is a room object.**
- A new class, `RoomAgent`, in the same Worker, is reached as `ROOMS.getByName('<workspaceId>:<roomId>')`.
- `roomId` is the room's own id: `app_rooms.id`, `INTEGER PRIMARY KEY AUTOINCREMENT`, never reused. A Topic's id is
  not used, because `app_topics.id` has no AUTOINCREMENT and SQLite can hand a deleted id to a new Topic (an undone
  create, for example), which would attach a new customer to an old room's database.
- Removing a Topic row erases its room's object.
- The Topic's row, setup, guidance and `app_key_reach` stay in the workspace. Its Conversation, threads, Persona forks
  and everything they write live in the room object.
- Each room runs its own Pi, with its own id space.

**A room chat's id says which room it is in.**
- Room chat ids are `<roomId>.<n>`, where `n` is the room's Pi id. Workspace chats keep bare integers.
- Chat ids are opaque TEXT everywhere else: never parsed or ordered, as ADR 0112's journal already treats them. AG-UI
  ids (`<chat>:a…`, runId `<chat>:<submission>`) split at the first `:`, so a dot is safe.
- `ChatId` widens to `^\d{1,12}(\.\d{1,12})?$`. The chat directory already allows a chat id that differs from its Pi
  session; room objects map the two at their edge.
- The Worker parses the prefix and routes a key's request straight to the room, with no lookup and without waking the
  workspace object.

**A room checks its own callers.**
- At creation a room stores the key that owns it (id and name). `keyRevoked` clears it.
- The edge forwards who is calling: the verified key id, or a member and their role.
- The room admits its owning key and the workspace's members, and refuses anyone else, without asking the workspace
  for `app_key_reach`.
- Entry ids inside a room are the room's own. Every cursor a client keeps (`entries?after=`, streams) is per chat
  already, so it stays valid.

**The workspace object is the control plane.** It keeps what is shared and what must have one writer: members, keys
and reach, Topics and setups, Personas and their revisions, MCP connections, credentials and grants, the budget, the
model endpoint, routines, Sources, files, apps, Events subscriptions and their delivery (ADR 0112), and a room
directory (`app_rooms`: topic, object, created, last activity).

A room asks it for the following over RPC, nothing else, each cacheable as noted:

| Room → workspace | When | Why it stays in the workspace |
| --- | --- | --- |
| `leaseToken(connection, stale?)` → `{token, expiresAt}` | A call on an owner connection with no live lease | Refresh tokens rotate. Only one object may refresh (`mcp.refresh:<id>`), or two refreshes race and the server falls to `needs_auth`. |
| `grants(connection)` → `{policy, version}` | Cached; a push invalidates it | One owner-edited table. A held call binds the version. |
| `holdApproval(…)` / workspace calls `room.decided(…)` | Ask-first or URL request | The owner decides in the workspace UI. |
| `admit()` → `{open, until, versions: {setup, grants, model, skills}}`; `usage(tokens)` | At each turn's admission, and before tool calls (cached a few seconds); usage after each model response, batched | One daily ledger per account. The overshoot stays bounded by the turns in flight, as today. The versions let a room that missed a push see its copies are stale and fetch them before the turn runs. |
| `model(id)` → endpoint | Cached; a push invalidates it | The sealed endpoint key. |
| `persona(id, revision?)` → definition, model, native tool set | At the ask, then frozen in the fork (as today) | Personas are edited in the workspace. |
| `skills(connection, prefix)` / `skillFile(digest)` | Cached by generation; a push invalidates it | Listings travel over the owner's connection. Files are content-addressed. |
| `report({chat, topic, entry, activity, attention, seq})`, plus the title, closed state and reply counts the owner's views show | Each turn boundary, write and activity change, idempotent by `seq` | The workspace appends it as is to ADR 0112's journal (its pure payload module computes the same fields), so subscribers keep one endpoint and one cursor. It also feeds the owner's sidebar and the workspace feed. |

The workspace pushes to a room:
- the Topic's setup and guidance with its revision, whenever they change;
- `keyRevoked`, `archive` and `restore`;
- invalidations for grants, the model and skills;
- `erase`.

**A room's copies are caches with versions.** The setup and guidance, grants, model endpoint and skills listing a
room holds carry the workspace's version. A push can fail while a room sleeps, so a room fetches its copies when it
wakes, and `admit()` returns the current versions. A room never runs a turn on a copy older than the workspace's.

**A room serves its own chats.** Key and member requests that name a room chat are routed to the room. These include:
- send and thread start (ADR 0111's `RunAgentInput`), entries, history, queue, stop and update;
- ADR 0110's SSE stream, and Persona answers;
- `inspect_*` for a named chat.

ADR 0103 thread servers, ADR 0110 streams, Persona invocations and forks, memory, the room's retrieval index,
receipts, held calls and the run ledger all live in the room. They are the same code, moved and composed into
`RoomLive` from the areas' layers, not rewritten.

**What spans rooms fans out or is read from the directory.**
- Owner lists and `/workspace/events` read `app_rooms` and the reported views.
- `search_chats` from main that names a room asks that room.
- `inspect` across a key's rooms queries each room the key reaches, bounded.
- Erasing a workspace erases every room object listed in `app_rooms`, then `app_rooms` itself, then the workspace's
  own tables.

**Gaps ADR 0108 left are closed.**
- Routines and Sources cannot target a room.
- `mcp_call` results materialize in the room's own files, never the owner's.
- The per-key rate limit is counted exactly once, as ADR 0085's fixed minute promises. It moves out of the agent
  into a small per-key object (`LIMITS.getByName(keyId)`) that the edge asks before routing. A rate-limit binding is
  approximate per location, so it isn't used.

**No migration.** Rooms made before this release stay in the workspace object, read-only after a cutover date: they
are archived, their history stays readable, and new work opens a new room. A server re-creates a customer's Topic on
its next use. Swarmm does this already through its channel epoch (`goblin_epoch`). Swarmm prod had no customers on
2026-10-22.

## Consequences

- **Rooms run apart.** One room's slow request, heavy turn, memory spike or crash touches only that room. A deploy
  wakes rooms lazily, one by one as they are used. Each customer's data is its own database, and deleting a customer
  is deleting one object.
- **The workspace object handles only control-plane calls.** A room's turn touches it for a token lease, a budget
  check, usage and a report, all small and mostly cached. A key's request never passes through it.
- **ADR 0110 streams are served per room.** A reader holds a room awake, never the workspace. ADR 0112 Events
  subscriptions stay one per key, fed by room reports.
- **Room chat ids change shape.** Clients that pattern-check ids (Swarmm's `ChatId`) widen their pattern, and the
  web's `/c/<id>` routes accept it.
- **The cost is more objects and RPCs.** A room's first request after a deploy wakes it, opens its Pi and fetches its
  copies. Swarmm's acceptance run measures that first send after each deploy.
  Cross-room owner views read reported state, so they can lag a report behind.
- **Budget stays approximate across rooms,** as it is across turns today.
- **Not chosen:**
  - **Agents SDK dynamic agents (facets):** same machine as the parent, no alarms, the parent on every frame. The
    SDK's docs advise against them for many chats per user.
  - **Its `RoutedAgents` hub** fits the shape (workspace as hub, rooms as targets). Goblin keeps its own edge routing
    and `getByName`, with `app_rooms` as the catalog.
  - **One workspace per customer:** it duplicates Personas, connections and keys per customer.

## How it lands (after ADRs 0110–0112 reach prod)

1. **Close ADR 0108's gaps** (routines, Sources, received files) and move key rate limits to the edge. This needs no
   object split.
2. **Add `RoomAgent`, the `ROOMS` binding and the control-plane RPC** on the workspace, with contract tests. Nothing
   routed yet.
3. **Room chat ids and edge routing.** A key's Topic create makes a room. Send, thread start, entries and history are
   served there, and the room checks its own callers.
   - `ChatId` widens in contracts, so ADR 0110's stream route and ADR 0111's `threadId` follow with no edit.
   - Check the web's `/c/<id>` and `/w/<slug>/c/<id>` route params, and every `Number(chat)` in the runtime.
4. **Persona invocations and forks in rooms** (persona, token lease, budget, model, skills).
5. **Streams (0110) and reports (feeding 0112 and the owner's views) from rooms.** Held calls round-trip.
6. **Inspect, archive and restore, and erasure. Existing rooms are archived at the cutover.** Swarmm re-creates
   Topics on its next use. Swarmm widens its own `ChatId` already in its ADR 0111 change, so it changes only once.

Each slice is dev first, with the authenticated dev acceptance and Swarmm's acceptance run (one Double Text, one
Lockup) before prod.
