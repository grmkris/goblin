# ADR 0081: API keys, and the same operations over /mcp

Status: Accepted. Amends ADR 0038 (the owner API is no longer cookie-only) and ADR 0003 (`/mcp` serves a second set
of tools to API-key callers).

The owner's typed API admitted only a browser session: the edge refused any `Authorization` header, and writes needed
the app's Origin and the CSRF header. A server the owner runs (a customer-facing service, a script, a CI job) could
reach its own agent only by holding that browser session, which carries every power of the owner, renews resident
authority and expires on the browser's terms. Inbound `/mcp` OAuth clients can only ask in Personal and inspect.

## Decision

**Keys.** The owner creates API keys in Settings. A key is Better Auth's `apiKey()` plugin row in the auth D1
(`0001_api_keys.sql`): hashed, prefixed `gbk_`, with a name, an expiry (90 days by default, a year at most), an explicit
per-key rate limit, its scopes as permissions and a server ceiling as metadata. Keys are created, listed and revoked
only by a signed-in owner through the account API (`/api/keys`); the plugin's own HTTP routes are closed, and a key can
never mint or list keys. The plugin never turns a key into a session.

**Admission.** The edge admits a request either by its session cookie, as before, or by `Authorization: Bearer
gbk_…`. A key resolves to the user who created it; the agent is still chosen only from that user (ADR 0004). A key
request is a server's: it must carry neither a cookie nor an `Origin`, and needs no CSRF header. Any other bearer
(an inbound OAuth token) stays refused on `/api`. The edge forwards the key's id, scopes and server ceiling to the
agent with the owner forward; owner admission re-checks the scope and **never renews resident authority** for a key,
since a key is not the owner's presence and a leaked one must not extend it.

**Scopes.** An endpoint accepts a key only when its contract annotates it with `ApiKeyScope`:

| Scope | Endpoints |
| --- | --- |
| `topics` | `topics.create`, `topics.update`, `topics.setSetup` |
| `conversations` | `conversations.submit`, `conversations.startThread`, `conversations.entries`, `conversations.stop` |
| `personas` | `personas.create`, `personas.detail`, `personas.update` |

Everything else (event streams, snapshots, files, MCP connections and grants, resident authority, Sources, Persona
hold replies, keys, inbound clients) refuses a key before the agent runs.

**Reach.** A key reaches only the Topics, their chats and the Personas it created itself (`app_key_reach`). Personal,
the owner's own Topics and Personas, and any resource another key created are out of reach; reusing an operation id
cannot adopt one (`Conflict:key_reach`). A setup a key writes stays under its ceiling: only the MCP servers named on
the key, explicit tool lists (never `all`), no apps and no subagents. A Persona tag in a key's message must name a
Persona within reach.

**Forward read.** `GET /api/conversations/:id/entries?after=&limit=` returns a chat's entries after a cursor, oldest
first, normalized for a server: owner and agent messages with their final flag, Persona answers with their revision
and any hold, and `ask_user` questions; with the chat's activity and its newest Persona invocations. It is open to the
owner's session too. The event streams stay what they are.

**The same operations over /mcp.** A `gbk_` bearer on `/mcp` gets one tool per annotated endpoint (`topic_create`,
`conversation_send`, `conversation_entries`, `persona_create`, …). Each tool calls the agent's typed owner API with the
key's forwarded principal, so admission, scopes, reach and the handlers are one code path. An inbound OAuth token keeps
`ask_agent` and the inspection tools.

## Consequences

- A key's Topics run owner turns. Topic setup narrows tools, but built-in tools such as cross-Topic search are still
  the owner's, and `searchExcluded` is not isolation. Whoever feeds a key's Topics content from other people (a
  customer-facing service) must treat that as owner authority until Goblin has a customer trust mode.
- Resident authority is renewed only by the owner. When it lapses, key calls that need it fail as they would for the
  owner, and the caller must report it.
- The schema changes are additive (an auth D1 migration and a new agent migration) so that production keeps its
  accounts; both fold into the baselines at the next reset the owner decides on.
