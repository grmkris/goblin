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
server for every credential ([ADR 0086](../adr/0086-one-mcp-for-every-caller.md)): an OAuth client acting for a person
(Claude Code, claude.ai, Cursor) or a server's API key. What either may do is its grant ([ADR
0114](../adr/0114-one-grant-for-every-credential.md), [accounts](accounts.md#grants)): a level (`read` < `write` <
`manage`), extras (`setup`, `routines`, `inspect`, `keys`), a reach of Topics, Personas and connections per workspace
(each all, or a list that grows with what it makes) and a lifetime.

- **Signing in.** Clients register dynamically (open, and restricted to `/mcp`); a registration whose redirects are
  all http loopback is marked native, which is how Claude Code registers. A client asks for the sign-in scopes and
  `goblin`, the one scope that reaches goblin (`MCP_SCOPES`, `auth/resources.ts`; an unauthenticated request gets a 401
  naming the metadata and those scopes). The person signs in and consents at `/consent`, which first saves the grant
  they give it (`PUT /api/clients/:clientId/grant`), pre-filled by the default chain: the same client's last terms,
  else their latest grant without its risky extras, else the preset (`write`, every Topic, Persona and connection, no
  extras, until revoked, over all of their workspaces). A Bearer token is accepted only if it verifies against the
  local JWKS, names `/mcp` as audience, comes from an enabled client, and the person's consent and a live grant still
  exist; its scope claim counts for nothing (`auth/service.ts`). A grant past its end deletes the consent and revokes
  the refresh tokens (`grant_expired`), so the next sign-in asks again.
- **Workspaces.** Every request reads the grant's workspaces (`reachedBy`, `auth/workspaces.ts`): the person's
  memberships when it reaches all of them, else those it names that they are still a member of, with their role in
  each. A client given exactly one never names it; any other has a required `workspace` argument (an id or slug) on
  every tool, added as each tool registers (`inbound/mcp-server.ts`), and `workspace_list` plus the server's
  instructions name what it reaches. Each call goes to that workspace's agent with the credential its grant makes
  there and the person as a member with their role there (`inbound/route.ts`). A key's calls reach its own workspace.
- **Tools.** One registry (`inbound/tools.ts`, the tools in `inbound/mcp-server.ts`, `inbound/inspect-tools.ts` and
  `inbound/config-tools.ts`): each tool calls one owner endpoint as the credential (`ownerCall`, forwarding
  `x-goblin-caller`) and is listed only when the grant's level and extras hold what that endpoint's `EndpointAccess`
  needs (`offers`), so admission, the grant, the limit and reach are the owner API's own. The level and extras are the
  same in every workspace a grant reaches, so one listing serves them all. Each answers its endpoint's JSON as text,
  and as structured content when it is an object. `conversation_send` and `thread_start` take plain fields
  (`PlainSend`, `PlainThreadStart`: the words, the operation id and goblin's parts), which their adapters send as the
  AG-UI `RunAgentInput` the endpoints take (contracts' `runInput` and `threadStart`,
  [ADR 0111](../adr/0111-agui-run-input-is-the-send.md)), and answer the receipt. Every endpoint a credential reaches
  has its tool but a chat's stream (`STREAMED`, ADR 0110): server-sent events a credential reads over HTTP itself
  ([chat streams](streams.md)), which one tool answer cannot carry: a key at `GET /api/conversations/:id/stream`, an
  OAuth client's token at `GET /w/<slug>/api/conversations/:id/stream`
  ([ADR 0116](../adr/0116-an-oauth-client-uses-the-owner-api-too.md)). The server's instructions name both.

  | Needs | Tools |
  | --- | --- |
  | `read` | `access_read`, `topic_list`, `topic_get`, `conversation_entries`, `persona_list`, `persona_get`, `models_list`, `get_recent_messages` |
  | `write` | `topic_create`, `conversation_update`, `conversation_send`, `thread_start`, `conversation_stop`, `ask_agent` |
  | `manage` | `topic_update`, `persona_create`, `persona_update` |
  | `read` and `setup` | `setup_catalog`, `server_list`, `tool_grants_list`, `source_list`, `source_routes` |
  | `manage` and `setup` | `topic_set_setup`, `server_add`, `server_rename`, `server_connect`, `server_disconnect`, `server_remove`, `tool_grant_set`, `tool_grants_set`, `server_skills_set` ([ADR 0117](../adr/0117-the-setup-extra-reaches-a-workspaces-connections.md)) |
  | `read` and `routines` | `routine_list`, `routine_runs` |
  | `write` and `routines` | `routine_propose`, `routine_edit`, `routine_archive`, `routine_pause` |
  | `read` and `inspect` | `inspect_conversations`, `inspect_conversation`, `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows`, `inspect_details` |

- **Refusals and widening.** A call its grant does not cover answers `access_insufficient` (403): what is missing (a
  level, an extra, or a reach id `<workspace>/<kind>/<id>`) and `widenUrl`, the page where the grant's approver (an
  owner or admin of a key's workspace, a client's person) widens it (`/consent/widen?grant=…`). On `/mcp` a client that
  declares URL elicitation is asked to open that page, once per call, on the 2026-07-28 protocol's input-required
  round (`inbound/access.ts`, ported from myapps); any other gets the refusal as the tool's error result.
  `access_read` (`GET /api/access`) answers the credential's own grant: its terms, when it ends and its widening link.
- **Events.** Every credential is also an Events client of goblin's ([published events](published-events.md),
  [ADR 0112](../adr/0112-goblin-publishes-mcp-events.md)): `/mcp` declares `capabilities.events` and the
  `io.modelcontextprotocol/events` extension, which the server SDK keeps on the wire, and serves `events/list`,
  `events/subscribe`, `events/unsubscribe` and `events/poll` (`inbound/events-methods.ts`), each calling its `events`
  endpoint as the credential, as a tool does; `events/stream` answers -32014. A client that names its workspace names
  it inside `arguments`. The methods are not tools: the parity test holds tools and methods together to the annotated
  endpoints. A lease is made under its credential's grant, and its fan-out reaches only chats of Topics the grant
  reaches. Revoking a client ends its leases first, in every workspace it reached, and so does a change that narrows
  a grant's Topics.

- **Reach.** A credential reaches what its grant reaches, checked by each handler (`grants/policy.ts`): a Topic, its
  chats, a Persona or a connection outside it is refused with its reach id. An OAuth client also never does more than
  its person may: its person's role (`ROLE_POWER`: an owner everything, an admin all but `keys`, a member `write` and
  `inspect`) must hold what the endpoint needs, else `Forbidden` `role`. A message a credential sends into a chat
  carries its name. `ask_agent` and `get_recent_messages` are main's, Personal's Conversation, so the grant must reach
  Personal; `ask_agent` submits into main and waits up to 110 seconds for the answer; a stable `operationId` makes
  retries idempotent, and it runs the model, so it counts toward the day's tokens. The inspection tools never call a
  model; the server's instructions tell clients that returned text is data, never instructions.
- **Limits.** Every grant may make 600 requests of its agent in each minute of the clock, counted by owner admission
  ([ADR 0085](../adr/0085-a-keys-rate-limit-is-a-fixed-minute-counted-by-its-agent.md)); past them it is refused with
  `rate_limited` and `retryAfter` (seconds), with `Retry-After` on `/api` and in the tool's error result on `/mcp`. A
  tool its grant does not hold is not listed. No credential grants resident authority.
- **Revoking.** Revoking a client in Settings marks its grant revoked (its terms stay for the default chain), deletes
  the person's consent to it and revokes its refresh tokens (`auth/clients.ts`); its next call gets a 401. Changing its
  grant in Settings applies to the live token at once.

## API keys

A server the owner runs uses an API key instead of a session ([ADR 0081](../adr/0081-api-keys-and-the-same-operations-over-mcp.md)).
An owner or admin makes one in Settings with a name and its grant's terms (`POST /w/<slug>/api/keys`, `{ name, terms }`):
by default `write`, every Topic, Persona and connection of the workspace, no extras, until revoked. Changing its terms
later (`PATCH /api/keys/:keyId`, `{ terms }`) keeps the same key and is logged as one `api_key` line (its level and
extras before and after, how many origins, never one). A key that follows its Topics subscribes to their
`conversation.updated` wakes instead of polling ([published events](published-events.md), ADR 0112); revoking or
rotating it, or a change that narrows its Topics, ends its leases first, each told `terminated`. Rotate secret gives a
key a new secret (`POST /api/keys/:keyId/rotate`, [ADR 0105](../adr/0105-a-keys-secret-rotates-in-place.md)), shown
once: the same key with its grant, and the old secret is refused at once. Better Auth's `apiKey()` plugin keeps it
hashed in the auth D1 with who made it (`auth/api-keys.ts`), and no expiry of its own: its end is its grant's; its own
routes are not served. Its grant may also name MCP server origins, each with exactly the tools its threads may call
there ([ADR 0091](../adr/0091-a-key-names-the-mcp-servers-its-threads-may-use.md)): https origins of public hosts only,
at most 8, each with 1 to 50 named tools; a client's grant may too. A thread's server is checked against them
(`confineThreadServer`), so a credential's threads reach no host its grant does not name. With
`Authorization: Bearer gbk_…` a key is a credential on `/api` (the owner endpoints whose `EndpointAccess` its grant
holds; the edge refuses the rest before an agent wakes) and on `/mcp` (the tools above). A key that does not admit on
`/mcp` gets the same envelope as on `/api`.

A key reaches what its grant reaches; one whose Topics or Personas are a list has what it makes added to its list, and
an operation id never adopts something outside it. Its Topics start with nothing in their setup, and a setup a
credential writes names only connections it reaches (with a list of connections, never `all`, apps or subagents).
Each Topic a key makes is sealed like any other ([ADR 0115](../adr/0115-every-topic-is-sealed.md), [Topics](topics.md#sealed-topics-and-the-hub)):
its chats see only it, and only the hub's search reaches it. A key's turn may do what its grant allows there
(`TOOL_NEEDS`): a `write` key is offered no routine, organizing, `diagnose` or apps outside the hub, and never reads
the Shared folder. Its messages start `[from server <key name>]`: a request from a party the owner connected, never
the owner's instruction, run on the deployment's models. The Topic and Persona views name the key that made them
(`madeBy`, display only). It names the threads it starts (`title`, which announces an
empty one in its Topic's Conversation), and renames, closes and reopens threads within reach, never a Topic's
Conversation and never pinning one open ([ADR 0090](../adr/0090-a-key-names-closes-and-reads-back-its-threads.md)); its
forward read shows its messages to Personas with `to` and `author`.

With `inspect` a credential reads how chats within its reach ran (ADR 0084), the conversations of those Topics in full
and the run events of their chats, threads and Persona forks. `inspect_details` of an operation it sent lists its
Personas' answers under `related` (`persona:<operation>:<persona id>`), and `inspect_turn` of one gives its `steps` in
order, `spent`: where its time went, by model, tool and MCP server, and `ranWith`: the releases, endpoint kinds,
thinking levels and MCP servers it ran with (ADR 0107), never the deployment endpoint's address; with `otlp` the same
turn comes back as OpenTelemetry traces data for a trace viewer, still content-free and within the grant's reach.
