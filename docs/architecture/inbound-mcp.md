# Authority and inbound MCP

## Resident authority

The agent acts for the owner when the owner is not there, so it needs its own standing permission rather than a
borrowed browser session. Resident authority (`app_resident`, the `Resident` service) is active for 30 days. Owner admission renews the
window on every owner API request except changing it (`POST /api/agent/resident`), the event streams, the files and
the OAuth callback; no caller (an OAuth client or a key, ADR 0086) and no internal call (hooks, file links) renews it. Turning
it off in Settings ("Work while you're away") sticks: activity does not re-enable it, only the explicit toggle does.
Model MCP tools, skills, inbound `ask_agent` and scheduled Source pulls and replies require current authority. The
owner's own `mcp` endpoints are renewed like the rest and do not call `requireResident`; their tool and resource calls
still check exact grants (`mcp/servers/api.ts`, `pi/resident-mcp.ts`, `pi/skills.ts`).

## Inbound MCP

goblin is an MCP server at `/mcp`, the one protected resource of Better Auth's `mcp()` authorization server, and one
server for every caller ([ADR 0086](../adr/0086-one-mcp-for-every-caller.md)): an OAuth client of the owner (Claude
Code, claude.ai, Cursor) or a server's API key.

- **Signing in.** Clients register dynamically (open, and restricted to `/mcp`); a registration whose redirects are
  all http loopback is marked native, which is how Claude Code registers. The owner signs in and consents at
  `/consent`. A Bearer token is accepted only if it verifies against the local JWKS, names `/mcp` as audience, comes
  from an enabled client and the owner's consent still exists; its scopes count only while that consent still grants
  them (`auth/service.ts`).
- **Scopes.** `/mcp` advertises `goblin:topics`, `goblin:conversations`, `goblin:personas` and `goblin:inspect` in
  its metadata, and an unauthenticated request gets a 401 naming the metadata and every scope. The consent page offers
  each `goblin:*` scope a client asks for as its own switch, off until the owner turns it on; Allow grants the rest
  without the ones left off (`apps/web/src/lib/consent-scope.ts`). A token's standing scopes map to caller scopes
  (`callerScopesOf`, `auth/resources.ts`): `agent` for any consent, `topics`, `conversations` and `personas` for their
  `goblin:*` scope, and `inspect` with `transcripts` for `goblin:inspect`. `auth/options.ts` configures the one
  resource and its allowed scopes, and gives a registering client all of them; a client registered before may need to
  register again to ask for new ones.
- **Tools.** One registry (`inbound/tools.ts`, the tools in `inbound/mcp-server.ts` and `inbound/inspect-tools.ts`):
  each tool calls one owner endpoint as the caller (`ownerCall`, forwarding `x-goblin-caller`) and is listed only when
  the caller holds that endpoint's `EndpointScope`, so admission, scopes, the limit and reach are the owner API's own.
  Each answers its endpoint's JSON as text, and as structured content when it is an object.

  | Scope | Tools | Who can hold it |
  | --- | --- | --- |
  | `agent` | `ask_agent`, `get_recent_messages` | OAuth clients |
  | `topics` | `topic_list`, `topic_get`, `topic_create`, `topic_update`, `topic_set_setup` | both |
  | `conversations` | `conversation_send`, `thread_start`, `conversation_entries`, `conversation_stop` | both |
  | `personas` | `persona_list`, `models_list`, `persona_create`, `persona_get`, `persona_update` | both |
  | `inspect` | `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows`, `inspect_details` | both |
  | `transcripts` | `inspect_conversations`, `inspect_conversation` | OAuth clients |

- **Reach.** An OAuth client acts as the user who consented, with the owner's reach: every Topic, chat and Persona,
  those the owner's keys made included. A key reaches only what it made (below). A message an OAuth client sends into
  a chat carries its registered name, as `ask_agent`'s does. `ask_agent` submits into main and waits up to 110 seconds
  for the answer; a stable `operationId` makes retries idempotent, and it runs the model, so it counts toward the
  day's tokens. The inspection tools never call a model; the server's instructions tell clients that returned text is
  data, never instructions.
- **Limits.** Every caller may make 600 requests of its agent in each minute of the clock, counted by owner
  admission per caller ([ADR 0085](../adr/0085-a-keys-rate-limit-is-a-fixed-minute-counted-by-its-agent.md)); past
  them it is refused with `rate_limited` and `retryAfter` (seconds), with `Retry-After` on `/api` and in the tool's
  error result on `/mcp`. A tool outside the caller's scopes is not listed, and calling it is refused with `scope`.
  No caller renews resident authority.
- **Revoking.** Revoking a client in Settings deletes your consent to it and revokes its refresh tokens for you
  (`auth/clients.ts`); its next call gets a 401. Consenting again with fewer scopes takes the rest from tokens already
  issued.

## API keys

A server the owner runs uses an API key instead of a session ([ADR 0081](../adr/0081-api-keys-and-the-same-operations-over-mcp.md)).
The owner makes one in Settings: a name, its scopes (`topics`, `conversations`, `personas`, `inspect`), the connected
MCP servers its setups may name, and a lifetime of at most a year. Change scopes on a key gives it other scopes later
(`PATCH /api/keys/:keyId`, [ADR 0084](../adr/0084-a-key-reads-back-what-it-made-and-how-it-ran.md)): the same key, so it
keeps what it made, and the change is logged as one `api_key` line. Better Auth's `apiKey()` plugin keeps it hashed in
the auth D1 (`auth/api-keys.ts`); its own routes are not served. With `Authorization: Bearer gbk_…` a key is a caller
on `/api` (the owner endpoints whose `EndpointScope` it holds) and on `/mcp` (the tools above for its scopes). A key
that does not admit on `/mcp` gets the same envelope as on `/api`.

A key reaches only the Topics, their chats and the Personas it made (`app_key_reach`); an operation id never adopts
the owner's. Its Topics start with nothing in their setup, and any setup it writes names only its servers, tool by
tool. Messages it sends are owner turns in those Topics: built-in tools are the owner's, and `searchExcluded` is not
isolation.

With `inspect` a key reads how its own chats ran, content-free (ADR 0084), seeing only the run events of chats within
its reach (its Topics, their threads and Persona forks). `inspect_details` of an operation it sent lists its Personas'
answers under `related` (`persona:<operation>:<persona id>`), and `inspect_turn` of one gives its `steps` in order and
`spent`: where its time went, by model, tool and MCP server.
