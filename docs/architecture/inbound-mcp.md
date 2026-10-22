# Authority and inbound MCP

## Resident authority

The agent acts for the owner when the owner is not there, so it needs its own standing permission rather than a
borrowed browser session. Resident authority (`app_resident`, the `Resident` service) lasts until the owner revokes it
(ADR 0088). Owner admission grants it on the owner's first API request, and on every one after except changing it
(`POST /api/agent/resident`), the event streams, the files and the OAuth callback; no caller (an OAuth client or a key,
ADR 0086) and no internal call (hooks, file links) grants it. Turning it off in Settings ("Work while you're away")
sticks: activity does not re-enable it, only the explicit toggle does.
Model MCP tools, skills, inbound `ask_agent` and scheduled Source pulls and replies require current authority. The
owner's own `mcp` endpoints grant it like the rest and do not call `requireResident`; their tool and resource calls
still check exact grants (`mcp/servers/api.ts`, `pi/resident-mcp.ts`, `pi/skills.ts`).

## Inbound MCP

goblin is an MCP server at `/mcp`, the one protected resource of Better Auth's `mcp()` authorization server, and one
server for every caller ([ADR 0086](../adr/0086-one-mcp-for-every-caller.md)): an OAuth client of the owner (Claude
Code, claude.ai, Cursor) or a server's API key.

- **Signing in.** Clients register dynamically (open, and restricted to `/mcp`); a registration whose redirects are
  all http loopback is marked native, which is how Claude Code registers. The person signs in and consents at
  `/consent`, which also asks which of their workspaces the client reaches (its **reach**, [ADR
  0097](../adr/0097-one-mcp-reaches-the-workspaces-its-consent-chooses.md)): those they choose, or all of them, ones they
  join later included. Allow sets the reach (`PUT /api/clients/:clientId/reach`, `auth/clients.ts`) and then the
  consent, which names no workspace. A Bearer token is accepted only if it verifies against the local JWKS, names
  `/mcp` as audience, comes from an enabled client, and the person's consent still exists; its scopes count only while
  that consent still grants them (`auth/service.ts`).
- **Workspaces.** Every request reads the reach (`reachedBy`, `auth/workspaces.ts`): the person's memberships for
  `all`, else the listed workspaces they are still a member of, with their role in each. A client given exactly one
  never names it; any other has a required `workspace` argument (an id or slug) on every tool, added as each tool
  registers (`inbound/mcp-server.ts`), and `workspace_list` plus the server's instructions name what it reaches. Each
  call goes to that workspace's agent as the person, a member there with their role there (`inbound/route.ts`). Keys
  are unchanged: a key's calls reach its own workspace.
- **Scopes.** `/mcp` advertises `goblin:agent`, `goblin:topics`, `goblin:conversations`, `goblin:personas`,
  `goblin:inspect`, `goblin:transcripts`, `goblin:setup` and `goblin:routines` in its metadata, and an unauthenticated
  request gets a 401 naming the metadata and every scope. The consent page offers each `goblin:*` scope a client asks
  for as its own switch ([ADR 0098](../adr/0098-admin-for-configuration-and-every-mcp-power-opt-in.md)): asking the
  agent starts on, the rest off; Allow grants what was asked without the ones left off
  (`apps/web/src/lib/consent-scope.ts`). A token's standing scopes map to caller scopes one for one (`callerScopesOf`,
  `auth/resources.ts`): `agent`, `topics`, `conversations`, `personas`, `inspect` (how chats ran, content-free),
  `transcripts` (conversations in full), `setup` (the setup catalog, the servers, the Sources and their routes) and
  `routines` (routines and their runs; drafting, changing, pausing and archiving take an admin, confirming stays the
  web's). `auth/options.ts` configures the one resource and its allowed scopes, and gives a registering client all of
  them; `0004_mcp_powers.sql` gave clients registered before the whole list.
- **Tools.** One registry (`inbound/tools.ts`, the tools in `inbound/mcp-server.ts` and `inbound/inspect-tools.ts`):
  each tool calls one owner endpoint as the caller (`ownerCall`, forwarding `x-goblin-caller`) and is listed only when
  the caller holds that endpoint's `EndpointScope`, so admission, scopes, the limit and reach are the owner API's own.
  Each answers its endpoint's JSON as text, and as structured content when it is an object.

  | Scope | Tools | Who can hold it |
  | --- | --- | --- |
  | `agent` | `ask_agent`, `get_recent_messages` | OAuth clients |
  | `topics` | `topic_list`, `topic_get`, `topic_create`, `topic_update`, `topic_set_setup` | both |
  | `conversations` | `conversation_update`, `conversation_send`, `thread_start`, `conversation_entries`, `conversation_stop` | both |
  | `personas` | `persona_list`, `models_list`, `persona_create`, `persona_get`, `persona_update` | both |
  | `inspect` | `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows`, `inspect_details` | both |
  | `transcripts` | `inspect_conversations`, `inspect_conversation` | OAuth clients |

- **Reach.** An OAuth client acts as the person who consented (`ownerCall` forwards them as its member), with the
  owner's reach in that one workspace: every Topic, chat and Persona, those the workspace's keys made included. A key
  belongs to one workspace and reaches only what it made there (below). A message an OAuth client sends into
  a chat carries its registered name, as `ask_agent`'s does. `ask_agent` submits into main and waits up to 110 seconds
  for the answer; a stable `operationId` makes retries idempotent, and it runs the model, so it counts toward the
  day's tokens. The inspection tools never call a model; the server's instructions tell clients that returned text is
  data, never instructions.
- **Limits.** Every caller may make 600 requests of its agent in each minute of the clock, counted by owner
  admission per caller ([ADR 0085](../adr/0085-a-keys-rate-limit-is-a-fixed-minute-counted-by-its-agent.md)); past
  them it is refused with `rate_limited` and `retryAfter` (seconds), with `Retry-After` on `/api` and in the tool's
  error result on `/mcp`. A tool outside the caller's scopes is not listed, and calling it is refused with `scope`.
  No caller grants resident authority.
- **Revoking.** Revoking a client in a workspace's Settings deletes your consent to it for that workspace and revokes
  its refresh tokens for it (`auth/clients.ts`); its next call gets a 401. Consenting again with fewer scopes takes the rest from tokens already
  issued.

## API keys

A server the owner runs uses an API key instead of a session ([ADR 0081](../adr/0081-api-keys-and-the-same-operations-over-mcp.md)).
The owner makes one in Settings: a name, its scopes (`topics`, `conversations`, `personas`, `inspect`), the connected
MCP servers its setups may name, and a lifetime of at most a year. Change scopes on a key gives it other scopes later
(`PATCH /api/keys/:keyId`, [ADR 0084](../adr/0084-a-key-reads-back-what-it-made-and-how-it-ran.md)): the same key, so it
keeps what it made, and the change is logged as one `api_key` line. Rotate secret gives a key a new secret
(`POST /api/keys/:keyId/rotate`, [ADR 0105](../adr/0105-a-keys-secret-rotates-in-place.md)), shown once: the same key,
with its scopes, servers, origins, expiry and reach, and the old secret is refused at once. Better Auth's `apiKey()`
plugin keeps it hashed in the auth D1 (`auth/api-keys.ts`); its own routes are not served. The owner may also grant it
MCP server origins, each with exactly the tools its threads may call there (`origins`, Change servers in Settings,
[ADR 0091](../adr/0091-a-key-names-the-mcp-servers-its-threads-may-use.md)): https origins of public hosts only, at
most 8, each with 1 to 50 named tools. A thread's server is checked against them (`confineThreadServer`), so a key's
threads reach no host the owner did not name. With `Authorization: Bearer gbk_…` a key is a caller
on `/api` (the owner endpoints whose `EndpointScope` it holds) and on `/mcp` (the tools above for its scopes). A key
that does not admit on `/mcp` gets the same envelope as on `/api`.

A key reaches only the Topics, their chats and the Personas it made (`app_key_reach`); an operation id never adopts
the owner's. Its Topics start with nothing in their setup, and any setup it writes names only its servers, tool by
tool. Messages it sends are owner turns in those Topics: built-in tools are the owner's, and `searchExcluded` is not
isolation. It names the threads it starts (`title`, which announces an empty one in its Topic's Conversation), and
renames, closes and reopens its own threads, never a Topic's Conversation and never pinning one open
([ADR 0090](../adr/0090-a-key-names-closes-and-reads-back-its-threads.md)); its forward read shows its messages to
Personas as the owner's, with `to`.

With `inspect` a key reads how its own chats ran, content-free (ADR 0084), seeing only the run events of chats within
its reach (its Topics, their threads and Persona forks). `inspect_details` of an operation it sent lists its Personas'
answers under `related` (`persona:<operation>:<persona id>`), and `inspect_turn` of one gives its `steps` in order,
`spent`: where its time went, by model, tool and MCP server, and `ranWith`: the releases, endpoint kinds, thinking
levels and MCP servers it ran with (ADR 0107), never the deployment endpoint's address; with `otlp` the same turn
comes back as OpenTelemetry traces data for a trace viewer, still content-free and within the key's reach.
