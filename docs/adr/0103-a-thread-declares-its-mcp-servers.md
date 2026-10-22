# ADR 0103: A thread declares the MCP servers its Personas call

Status: Accepted 2026-10-22 with the owner. Builds on ADR 0091 (a key names the MCP servers its threads may use), ADR
0101 (a Persona fork's tools are its own) and ADR 0102 (a Persona's choice of them). Amends ADR 0090 (the thread
operation and a key's change of a thread).

A server that runs paid jobs through goblin, Swarmm, wants each job's thread to work with its own MCP tools (propose a
plan, report progress, import a file, deliver) through a token it mints for that job, the way Anthropic's MCP connector
and OpenAI's remote MCP tool take a server per request. ADR 0091 let the owner grant a key the origins and tools its
threads may call; this is the thread side.

## Decision

**Declaring.** `StartThread` takes `mcpServers`, at most four `{ name, url, token, tools? }`, each name once
(`ThreadServer`): `name` is lower case, starts with a letter, at most 20 characters and never holds `__`; `tools`
names the tools of the origin's list it may call (all of them when absent). The key-scoped
`PATCH /api/conversations/:id` takes `mcpServers: { operationId, set }`, which replaces the thread's servers as a whole
in one step (`[]` removes them). Only a Thread declares servers: never a Topic's Conversation, main or a Persona's fork
(`not_a_thread`). On `/mcp`, `thread_start` and `conversation_update` carry the same fields.

**Key callers only, inside the owner's grant.** Anyone but a key is refused (`key_only`), save that the owner may clear a
thread's servers (`set: []`). Each server's URL must be https with no credentials, query or fragment and a host that is
a name, not an IP literal (`thread_server_url`), and passes `confineThreadServer`: its origin one the owner granted the key, its tools a subset of that origin's (`key_origin`,
`key_origin_tool`). Every server is checked before the thread operation makes anything, so a refused one makes no thread,
and a change's servers are checked before the change writes anything. The granted origin is the network fence (ADR 0091
refuses IP literals, single-label and local names, now with a trailing dot too). The transport sends every request with
`redirect: manual` and follows a redirect only within the server's origin (a 307 or 308, or a GET; the MCP SDK's
same-origin policy, set explicitly here and the default the owner's connections use too), so the bearer never leaves
the origin and any other redirect fails the request. Every request is bounded in time (90 s) and its answer in size
(1 MiB), like the owner's connections.

**The token.** It is encrypted with the credential cipher, bound to the workspace, the thread, the server's name and
its endpoint, in `app_thread_servers`. It
never reaches Pi, flows, the run ledger, error envelopes, snapshots or logs: answers echo `{ name, url, tools }` only
(`ConversationView.mcpServers`). It is opened only to send a request.

**Only the newest operation changes them.** Every operation that sets a thread's servers, a thread operation's or a
change's, is recorded in order with the digest of what it declared, tokens left out (`app_thread_server_ops`), an empty
set too. Swarmm mints a token per dispatch attempt and keeps only its hash, so a retry sends the same `operationId` with
new tokens: the newest operation again, naming the same servers (names, endpoints and tools), swaps their tokens at once,
so the newest token is the live one. An older operation again, the same, answers what stands and changes nothing, so a
late replay never undoes a later change or revives what an empty set or a close removed. An operation naming other
servers than it first did is a `Conflict` (`thread_servers`). Tokens are sealed first; the check and the write are one
synchronous step after. The servers are stored on the thread before its first message is sent, so the Personas it tags
see them, and only once the operation may start (the day's budget is not spent and its message says something), so a
refused one leaves no servers. A replay onto a thread closed since answers as one without servers does. A set is
written only while the thread is open and its Topic live, checked in the same step, so one in flight during a close or
an archive never lands after the drop.

**The key's grant, at every use.** Each server keeps the key that declared it. Freezing a fork's set and every call
check that the key still exists, is unexpired and still grants that origin and tool (read from the auth store); a server
whose key is gone or no longer grants its origin is refused and dropped, wherever that key declared it, and a tool no
longer granted is no longer offered or called. Only a Persona the declaring key reaches gets its servers' tools.

**Lifetime.** Closing a thread drops its servers and those of every chat under it, archiving its Topic drops those of
all its threads before its chats are stopped (so one that cannot stop keeps none), and reopening or restoring brings
none back: the server attaches them again with a new operation.

**Behaviour.** The thread's Persona forks that take native tools (ADR 0102) freeze its servers' tools with their own
(ADR 0101): each server is opened statelessly over Streamable HTTP with its token and listed (page by page, at most 1
MiB in all), and its tools on the list that the model may be offered are named `<name>__<tool>`. The owner's
connections keep their names: a declared name that a connection's alias already is takes a short hash. They count as
the Persona's own. Every call checks again: resident authority (ADR 0088; a key's thread still needs it), the fork's
thread still open, the server still declared there with the tool on its list, and the arguments against the frozen
schema (ADR 0092), then sends with the token stored now. The tools are act-only: ask-first cannot work in a key's thread,
where no owner is there to approve, so nothing of them is held; URL requests are not taken. Results are the server's,
untrusted, as an `mcp_call`'s; the run recorder names the server `thread:<name>` and the tool, content-free.

## Consequences

- A server gives each job its own tools and token, revokes them by changing the thread's servers or closing it, and a
  retried dispatch never fails on its own token.
- The owner's grant is still exact: origins and tools on the key; a thread can only narrow it, and revoking the key or
  narrowing its origins ends what its threads declared at their next use.
- Checking the key at every use reads the auth store once per freeze and per call.
- A fork on the gateway (ADR 0102) does not reach a thread's servers: `mcp_call` names the owner's connections only.
- `persona_get`'s `exposedTools` is the Persona's own setup; a thread's servers add theirs in that thread's forks.
