# ADR 0084: A key reads back what it made, and how its chats ran

Status: Accepted. Amends ADR 0081 (more endpoints accept a key, a fourth scope, and the owner can change a key's
scopes) and ADR 0024 (inspection has a content-free reading for keys, and a turn's timeline says where its time went).

ADR 0081 gave a server's API key enough to make things, not to manage them. A server that made 47 Personas and a Topic
per customer could not list them, could not read a Topic's instructions back to roll a change out across its Topics,
and could not check which models a Persona may name before writing one. Nor could it see how its chats ran: a Persona
job that took 36 minutes answered nothing about why, because inspection was the owner's alone (`goblin:inspect` on an
OAuth client, the owner's own Details). And a key reaches only what it made, so a new key with more scopes would see
none of the old key's Personas.

## Decision

**Inventory.** Four more owner endpoints carry `ApiKeyScope`, each a tool on `/mcp` for a key, and each for the owner's
session too:

| Endpoint | Scope | Tool | Answers |
| --- | --- | --- | --- |
| `GET /api/topics?cursor=&limit=` | `topics` | `topic_list` | A page of Topics newest change first: id, name, conversation, revision, archived, searchExcluded, updatedAt |
| `GET /api/topics/:id` | `topics` | `topic_get` | One Topic with its description, instructions, revision and setup |
| `GET /api/personas?name=&cursor=&limit=` | `personas` | `persona_list` | A page of Personas newest change first, each with its setup in a line (servers with tool counts, skills, apps) |
| `GET /api/models` | `personas` | `models_list` | The models a Persona may name now, the default first |

Pages hold at most 100 behind an opaque cursor (`<updatedAt>.<id>`), read in one statement: a key's list joins
`app_key_reach`, so it holds exactly the key's own; the owner's holds every one, archived ones too.

**Inspection for keys.** A fourth scope, `inspect`, opens the content-free inspection reads, as owner endpoints and as
key tools: `GET /api/inspect/turns` (`inspect_turns`), `/api/inspect/turn?operation=` (`inspect_turn`),
`/api/inspect/problems` (`inspect_problems`), `/api/inspect/flows` (`inspect_flows`), and the existing
`GET /api/conversations/:id/details` (`inspect_details`). The conversation reads (`inspect_conversations`,
`inspect_conversation`) stay the owner's: a key never reads words through inspection. Run events carry no content
(ADR 0024), so neither do these.

A key sees only the run events of chats within its reach: the Topics it made, their threads and Persona forks. Each
event is placed by what it names, its Pi session, else its chat, else its Topic (`inspectReach` in `keys/policy.ts`,
memoized per request). A list keeps only events in reach, scanning newest first at most 4096 rows; an operation is found
only when some of its events are in reach and none is outside it; a details' path chat must be in reach, and its
`related` operations are filtered the same way. Anything else is `not_found`, as for the rest of a key's reach.

**Where a turn's time went.** Every turn timeline (the owner's and a key's) gains `steps`, its model attempts, tool
calls, compactions and errors in order, each with its start offset from the turn and its duration, and for a model
attempt its model, tokens, finish reason and time to first chunk, for a tool call its tool, the MCP server and tool it
reached, and its failure or block class; and `spent`, the turn's wall time, its summed model and tool time, tool time by
MCP server, and the rest (waiting, queueing, the host's own work). A Persona's answer is the operation
`persona:<the send's operation>:<persona id>`, which the send's details list under `related`.

**Changing a key's scopes.** `PATCH /api/keys/:keyId` `{ scopes }`, on the account API, for a signed-in owner only (a
key never reaches the account API), replaces the key's scopes through Better Auth's server-side update. It is the same
key: the same id and secret, so what it made stays within its reach. Each change writes one `api_key` log line with the
key's id and its scopes before and after, never its secret. Settings → API keys offers it as Change scopes on each key.

## Consequences

- A server can manage what it made and roll a Topic instruction out across all its Topics; deleting or archiving
  Personas and dry runs remain out of scope.
- A key's inspection is bounded by its reach, so the owner's own turns, Personal and other keys' chats stay invisible
  to it, while the owner sees everything as before. A list scan that finds fewer than asked within 4096 rows says less
  than the ledger holds; narrowing by `since` or a chat reaches further.
- `steps` and `spent` are derived from the events already recorded, so no schema changes. Tool calls can run side by
  side, so model plus tool time can pass the wall time; `otherMs` is never below zero.
- Granting a scope needs the owner's session; a server cannot widen its own key. The audit is the Worker's log line,
  kept as long as Workers Logs keep it.
