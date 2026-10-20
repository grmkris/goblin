# ADR 0086: One /mcp for every caller

Status: Accepted. Amends ADR 0024 (what an OAuth client of the owner gets on `/mcp`, and where inspection is served),
ADR 0081 (the scope annotation and the key's forward become a caller's) and ADR 0085 (the limit is per caller).

`/mcp` served two different servers. An OAuth client the owner consented to got `ask_agent`, `get_recent_messages`
and, with `goblin:inspect`, seven inspection tools, through the agent's internal API (`/internal/ask`, `/recent`,
`/inspect`). A server's `gbk_` key got one tool per owner endpoint it could reach, through the owner API. The tools
that manage Topics, Personas and conversations therefore existed only for keys: to manage the owner's agent from
Claude Code, claude.ai or Cursor, an operator had to put a server's key into the client's configuration, which turned
off the client's own sign-in and confined it to what that key had made. The inspection reads existed twice, with
different shapes.

## Decision

**One caller.** A request that is not the owner's session comes from a caller: a server's API key (`kind: key`, its
id, scopes and server ceiling) or an OAuth client of the owner (`kind: client`, its id, registered name and scopes).
Only the Worker forwards it, in `x-goblin-caller`: the edge for a key on `/api`, `/mcp` for either. Owner admission
treats both alike: the endpoint's scope (`EndpointScope`, which replaces `ApiKeyScope`) must be one the caller holds
(else `Forbidden` `scope`), the caller is counted per fixed minute (600, else `Unauthenticated` `rate_limited` with
`retryAfter` and `Retry-After`), and it never renews resident authority. What it reaches past admission is its
kind's: a key only what it made (`keys/policy.ts`, `app_key_reach`), a client everything the owner does, the Topics and
Personas the owner's keys made included.

**One scope vocabulary.** `CallerScope` is `topics`, `conversations`, `personas`, `inspect`, `transcripts` and
`agent`. A key holds some of the first four, as before. An OAuth token holds what its standing consent maps to:
`agent` for any consent (asking the agent in main and reading main), `goblin:topics` → `topics`,
`goblin:conversations` → `conversations`, `goblin:personas` → `personas`, and `goblin:inspect` → `inspect` and
`transcripts`. Reach by principal is which scopes a principal can hold: no key can hold `transcripts` or `agent`.

**One server and one tool registry.** `/mcp` builds one server for the caller (`inbound/mcp-server.ts`,
`inbound/inspect-tools.ts`, the registry in `inbound/tools.ts`). Each tool is defined once, calls one owner endpoint
as the caller, and is listed only when the caller holds that endpoint's scope; a parity test holds the tools to the
annotated endpoints one to one. The internal API's `ask`, `recent` and `inspect` are gone: asking is `POST
/api/agent/ask` and `GET /api/agent/recent` (scope `agent`); inspection is the `inspect` group under `/api/inspect/`,
the two conversation reads (`conversations`, `conversation`) needing `transcripts` and the content-free ones
(`turns`, `turn`, `problems`, `flows`, `details`) needing `inspect`. `details` takes `operation`, or `chat` with
`entry`, on one path (`/api/inspect/details`), which the owner's Details sheet reads too. Every tool answers its
endpoint's JSON as text, and as structured content when it is an object.

**Consent.** `goblin:topics`, `goblin:conversations` and `goblin:personas` join `goblin:inspect` in the resource
metadata, the 401 challenge and the scopes a registering client is given. The consent page offers each `goblin:*`
scope a client asks for as its own switch, off until the owner turns it on, saying what it allows. A consent keeps
exactly what it granted; more needs consenting again. A message an OAuth client sends into a chat (as `ask_agent`'s
always was) carries the client's registered name; a key's stays an unlabelled owner message.

**No second path.** The split servers, the internal routes, the old scope annotation, the details path under a chat
and the `key_scope` / `key_rate_limited` reasons are removed, with nothing kept beside the new ones.

## Consequences

- Claude Code, claude.ai or Cursor manage the owner's agent by signing in; API keys are for servers again.
- An OAuth client with all scopes is the owner's full delegate over `/mcp`, short of resident authority, keys,
  connections, grants and Settings, none of which any caller reaches. The consent page says so scope by scope, and
  revoking the client ends it at once.
- A client registered before this change was stored with the scopes registration gave then; it may need to register
  again before it can ask for the new ones.
- A caller's refusals changed their reasons (`scope`, `rate_limited`) and `inspect_turn` takes `operation`; callers
  read `retryAfter` for a rate limit.
