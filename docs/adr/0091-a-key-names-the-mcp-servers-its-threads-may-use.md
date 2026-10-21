# ADR 0091: A key names the MCP servers its threads may use

Status: Accepted. Amends ADR 0081 (a key's ceiling) and ADR 0084 (the owner's change of a key).

A server that runs jobs through goblin wants each job's thread to work with the server's own MCP tools, through a
token it mints for that job. goblin's rule is that an outbound MCP call needs the owner's exact grant of the server and
the tool: nothing remote, and no caller, can grant one. A key that brought its own servers would break that rule.

## Decision

- **The owner grants origins on the key.** Beside its `servers` (connections its setups may name), a key's ceiling
  holds `origins`: each an MCP server origin with exactly the tools its threads may call there
  (`KeyOrigin { origin, tools }`). The owner sets them when making the key or later (`PATCH /api/keys/:keyId`
  `{ scopes?, origins? }`, Settings → API keys → Change servers); a key never changes its own.
- **What an origin may be.** An https origin only (scheme, host and port; no path, query or credentials),
  normalized; never an IP literal, a single-label host or a local or private name (`.localhost`, `.local`,
  `.internal`, `.home.arpa`, `.lan`). At most 8 per key, each with 1 to 50 named tools, never `all`. Anything else is
  refused when it is set (`key_origin`, `key_origin_tools`), by one check the Worker and Settings share
  (`keyOriginsOf`).
- **Where it is checked.** The key's origins travel with its forwarded caller, so the agent checks a thread's server
  without the auth store: `confineThreadServer(url, tools?)` (`keys/policy.ts`) takes a server on a granted origin, with
  the tools it names (a subset of that origin's) or the whole list, and refuses anything else (`key_origin`,
  `key_origin_tool`) and any caller but a key (`key_only`). The allowlisted origin is the network fence: a thread can
  reach no host the owner did not name.
- **Audit.** A change of a key's origins is one `api_key` line (`kind: origins`) with the key, the workspace, who
  changed it and how many origins it now has; no origin or tool is logged.

The threads that declare servers, their tokens and their tools are a later ADR's; it calls `confineThreadServer` for
each server a thread declares.

## Consequences

- The owner's grant stays exact: it names the origin and every tool, once, per key. A server's per-job tokens never
  widen it.
- Keys made before have no origins; their threads can declare none until the owner grants some.
