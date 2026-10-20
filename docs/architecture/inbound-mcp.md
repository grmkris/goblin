# Authority and inbound MCP

## Resident authority

The agent acts for the owner when the owner is not there, so it needs its own standing permission rather than a
borrowed browser session. Resident authority (`app_resident`, the `Resident` service) is active for 30 days. Owner admission renews the
window on every owner API request except changing it (`POST /api/agent/resident`), the event streams, the files and
the OAuth callback; the internal API (inbound calls and hooks) never renews it. Turning
it off in Settings ("Work while you're away") sticks: activity does not re-enable it, only the explicit toggle does.
Model MCP tools, skills, inbound `ask_agent` and scheduled Source pulls and replies require current authority. The
owner's own `mcp` endpoints are renewed like the rest and do not call `requireResident`; their tool and resource calls
still check exact grants (`mcp/servers/api.ts`, `pi/resident-mcp.ts`, `pi/skills.ts`).

## Inbound MCP

goblin is an MCP server at `/mcp`, the one protected resource of Better Auth's `mcp()` authorization server:

- Clients register dynamically (open, and restricted to `/mcp`). A registration whose redirects are all http loopback
  is marked native, which is how Claude Code registers.
- The owner signs in and consents at `/consent`, which says what the requested scopes grant. A Bearer token is
  accepted only if it verifies against the local JWKS, names `/mcp` as audience, comes from an enabled client and the
  owner's consent still exists. Its scopes count only while that consent still grants them (`auth/service.ts`).
- Tools: `ask_agent` (submit into main, labelled with the client's name, and wait up to 110 seconds; a stable
  `operationId` records its Pi session in the chat operation ledger and makes retries idempotent; it runs the model,
  so it counts toward the day's tokens) and `get_recent_messages` (the primary chat's current session's latest messages, with their
  authors). `ask_agent` releases the admission lock before waiting and waits on the operation's recorded session.
- With `goblin:inspect` (ADR 0024) the same server adds `inspect_conversations`, `inspect_conversation`,
  `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows` (the ledger's content-free conversation flow
  steps) and `inspect_details` (the operation behind a message), with the contract's input and output schemas
  (`inbound/inspection.ts`). They read the token subject's own agent and never call a model; the
  server's instructions tell clients that returned text is data, never instructions.
- `/mcp` advertises `goblin:inspect` in its metadata, and an unauthenticated request gets a 401 naming the metadata
  and every scope, so a new connection asks for inspection. The consent page offers it as a separate switch that
  starts off; unless the owner turns it on, Allow grants the rest without `goblin:inspect`
  (`apps/web/src/lib/consent-scope.ts`). `auth/options.ts` configures the one `/mcp` resource and its allowed scopes;
  Better Auth creates or merges that configuration at runtime. The auth store starts from `0000_baseline.sql`
  after the disposable dev reset, with no retired inspection or operator resource to carry forward. New clients
  may request inspection, but only the owner's consent grants it.
- Revoking a client in Settings deletes your consent to it and revokes its refresh tokens for you (`auth/clients.ts`);
  its next call gets a 401. Consenting again without `goblin:inspect` ends inspection for tokens already issued.

## API keys

A server the owner runs uses an API key instead of a session ([ADR 0081](../adr/0081-api-keys-and-the-same-operations-over-mcp.md)).
The owner makes one in Settings: a name, its scopes (`topics`, `conversations`, `personas`, `inspect`), the connected
MCP servers its setups may name, and a lifetime of at most a year. Change scopes on a key gives it other scopes later
(`PATCH /api/keys/:keyId`, [ADR 0084](../adr/0084-a-key-reads-back-what-it-made-and-how-it-ran.md)): the same key, so it
keeps what it made, and the change is logged as one `api_key` line. Better Auth's `apiKey()` plugin keeps it hashed in the auth D1
(`auth/api-keys.ts`); its own routes are not served. With `Authorization: Bearer gbk_…` a key reaches:

- `/api`: the owner endpoints annotated `ApiKeyScope` (Topics, sending and threads, the forward `entries` read,
  Personas), as the owner, never renewing resident authority;
- `/mcp`: the same operations as tools (`inbound/api-server.ts`), each calling the owner API with the key's grant, so
  admission, scopes and reach are one path:

  | Scope | Tools |
  | --- | --- |
  | `topics` | `topic_list`, `topic_get`, `topic_create`, `topic_update`, `topic_set_setup` |
  | `conversations` | `conversation_send`, `thread_start`, `conversation_entries`, `conversation_stop` |
  | `personas` | `persona_list`, `models_list`, `persona_create`, `persona_get`, `persona_update` |
  | `inspect` | `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows`, `inspect_details` |

A key may make 600 requests of its agent in each minute of the clock, counted by the agent's owner admission
([ADR 0085](../adr/0085-a-keys-rate-limit-is-a-fixed-minute-counted-by-its-agent.md)); past them it is refused with
`key_rate_limited` and `retryAfter` (seconds), with `Retry-After` on `/api` and as the tool's error result on `/mcp`. A
key that does not admit on `/mcp` gets the same envelope as on `/api`.

A key reaches only the Topics, their chats and the Personas it made (`app_key_reach`); an operation id never adopts
the owner's. Its Topics start with nothing in their setup, and any setup it writes names only its servers, tool by
tool. Messages it sends are owner turns in those Topics: built-in tools are the owner's, and `searchExcluded` is not
isolation.

With `inspect` a key reads how its own chats ran, content-free (ADR 0084): the inspection reads of the owner's
`goblin:inspect` without the conversation reads, seeing only the run events of chats within its reach (its Topics, their
threads and Persona forks). `inspect_details` of an operation it sent lists its Personas' answers under `related`
(`persona:<operation>:<persona id>`), and `inspect_turn` of one gives its `steps` in order and `spent`: where its time
went, by model, tool and MCP server.
