# Outbound MCP

## Outbound MCP

Connections come from `GOBLIN_MCP_SERVERS` (JSON: `connectionId`, `endpoint`, optional `label`, `issuer` and
`resource`) and from the owner, who may add up to thirty-two by URL (`app_mcp_connections`, ADR 0006). A server is an
address and a connection the owner's account on it (ADR 0041): the owner may connect one server several times, each
connection with its own id, sign-in, grants, skills switch and Events. Every connection has the owner's **label**
(`app_mcp_labels`, `mcp/labels.ts`), one line of at most eighty characters, unique whatever its case: given when it is
added (`AddServer.label`), else the first free name from goblin's own name for a first-class server (`Goblin Wallet
2`) or a server on the shelf (`Kiwi.com`, `suggestedTitle`), else its server card's title (`Example`, `Example 2`),
else its host, or the
configured `label` (else its id) for a configured one, set once at start; `PATCH /api/mcp/:id` renames it. Every
connection registers with its authorization server as plain `goblin` (ADR 0048: a consent screen names the app, not
goblin's own label); MCP has no standard "who am I", so goblin cannot show which account a sign-in reached. An added endpoint is a public https address
(`mcp/endpoint.ts`), and its server card's title, description and icon are the server's own claims, for the owner's
eyes only. Configured connections win on ID and cannot be removed. Removing an added connection forgets its row,
label, endpoint binding, credentials, pending sign-ins and grants in one transaction. A server goblin supports **first-class** (ADR 0043) has goblin's own profile, matched by exact endpoint
(`mcp/first-class.ts`, `ServerView.profile`): our title and words, the grants Review recommended access applies (free tools run
when needed, paid ones ask first), a paid tool with the argument that holds its amount (ADR 0044), the tool that opens
its own App, a status tool whose answer goblin decodes with its own schema (`WalletStatus`, bounded, the server's
claim), and a top-up link of our own that the wallet line offers as Add funds while that status says funding is
blocked (Mercator's account page; goblin's instructions send the owner there instead of retrying a job). Mercator is the first. goblin's own instructions (`pi/persona.ts`) send fresh web data and outside tasks to
it (search, describe, quote, job, result), and a model's call to a connection the owner has not signed in to answers
`{ kind: 'connect-required' }`, which the web shows as a Connect card; it ends the turn, counts in Needs you, and a
Persona holds on it as on any other (`connect`). Its card is listed first. Every connected card is a summary (`server-card.tsx`): a
first-class one shows its wallet (`GET /api/mcp/:id/status`, read from its status tool as the owner, null until that
tool is allowed) and, until those grants are in place, Review recommended access, which lists exactly the tools that
would run without asking and those that would ask first before one Allow (`POST /api/mcp/:id/recommended`,
`mcp/first-class-owner.ts`); a tool the server does not list now is skipped. Manage access opens the rest: goblin's
words in place of the server's, the paid tool's rule, events, settings and tools, the ones outside an App grouped by
the server's own read-only claim, each row opening to its raw name, hints and whole description. A `#connection-<id>`
link opens its card. Cloudflare's API is the second, from the shelf, for publishing a page as a
Worker: its resource offers only `user:read account:read`, so Connect and step-up add the profile's Workers scripts
scopes to what the server offers (`signInScope` in `owner-servers.ts`), and its `execute` asks first. Its own App opens from Open in its card's head or its pin, whatever the
owner has allowed, `/connections/<id>/app` (`server-app.tsx`, ADR 0053): `POST /api/apps/servers` makes once (or
reopens) the server's thread, an empty thread under Personal named after the server (thread operation
`server-app:<connection>`), and keeps the App there (`entrypoint` on its source); the page then goes to `/a/<id>`, where
`AppHost` loads it with its app tool called as the owner (`serverAppQuery`, on the panel `?focus=` names), rendered in
the same sandboxed frame as any MCP App and trusted for nothing. Any server's App opens this way: the tool its tools
declare as their global entrypoint (`_meta["openai/ui"].entrypoints`), kept per connection from its last whole tool list
(`app_mcp_entrypoints`, `mcp/entrypoints.ts`), so Open and the pin outlive the connection and the object. Its one
display mode is fullscreen. A frame reloads
only for a different App (another `focus` is one); a newer result of the same call reaches the live App through the
bridge (`deliver` in `lib/app-bridge.ts`). On its page, an App that calls a tool the owner has not allowed gets the
same Allow card as in a conversation. Until a
first-class server is connected, onboarding points to it: Activity's "Get started" row (`connect-offer.tsx`, Connect or
Not now, the dismissal kept in the browser) and the empty chat's line. Connections
also offers a shelf of suggested servers (`mcp/suggested.ts`, ADR 0052), with source comments recording their
connection checks, each in a group (`ServerSuggestion.group`) that the picker's Suggested tab and Start's services step
show under its name (`server-add.tsx`): the owner's own apps through one mysi connection
(`https://mysi.lol/mcp?codemode=off`; the query keeps every app's tools listed as `<service>_<tool>` under the same
OAuth resource), publishing (Cloudflare), then servers that need no sign-in by what they are for: travel, knowledge,
crypto data, views in the chat and code. The shelf is data, one endpoint per entry
([ADR 0061](../adr/0061-the-shelf-is-data.md)); a deployment's `MCP_SHELF` replaces an entry by its id or adds its own
(`shelfOf`). A suggestion is marked added when a connection has its endpoint's origin and path, whatever its query. One tap adds and
connects. It also searches MCP registries that speak
the generic registry API (`mcp/registry.ts`, `GET /api/mcp/catalog?q=`): the Official MCP Registry and GitHub's, built
in, then up to eight the owner adds (`app_mcp_registries`). A registry is
added only once it answers `/v0.1/servers`, and removing it keeps the servers added from it. Search reads one page of
up to twenty entries per registry and keeps https streamable-HTTP remotes, rejecting entries explicitly marked
inactive or not latest. Missing status metadata is accepted. Results are labelled by registry, each server once
(the official registry first), and cached for ten minutes. Each registry gets eight seconds (`Effect.timeout`). A
registry that is not reached fails as `UpstreamMcp` transport and one that answers anything but the registry API as
`not_a_registry`; in a search either is logged and leaves the answer partial and uncached (`mcp_suggest` says so, and
`GET /api/mcp/catalog` answers `{ entries, partial }`, which Connections shows). The catalog lives in the `McpServers`
layer (`layers/mcp.ts`), not the host.
Endpoint placeholders are filled with one safe path
segment each, and servers that require a secret header are listed but cannot be added yet. An added entry records
its registry, name and version. The owner connects each server from the Connections page:

1. `POST /api/mcp/:id/connect` first tries without sign-in. If needed, it runs the MCP SDK's `auth()` with our
   `StoredOAuthProvider`: discovery, dynamic client registration, PKCE. Only a flow needing consent returns a remote
   authorization URL; otherwise it returns `{}`. A server the open try cannot reach answers that transport failure;
   no sign-in starts for it, and its credentials are put back as they were (one never connected stays not connected,
   not `needs_auth`).
2. The remote server redirects to `/api/mcp/oauth/callback`. The pending state is single-use and expires after an
   hour (the wallet's consent includes its setup and funding); the code is exchanged and the tokens stored.
3. Client registration and tokens are AES-GCM encrypted at rest (`GOBLIN_CREDENTIAL_KEY`, bound to server ID and
   purpose); discovery metadata is stored in plain JSON.

Credentials and grants belong to the endpoint they were made for (`mcp/endpoints.ts`, `app_mcp_endpoints`). When the
agent starts and a server ID now points at another endpoint, everything stored for it is dropped in one short
transaction: credentials, client registration, pending authorizations and grants. The owner connects and grants
again, so tokens issued by one host never reach another.

Calls go through the connection manager (`McpConnections`, `mcp/manager.ts`), keyed by server ID, which caches a
connection and closes it after five minutes idle. Its auth provider (`mcp/auth.ts`) refreshes a token a minute before
expiry, one `SingleFlight` per server, and refreshes once after a 401. A refresh the authorization server refuses (an
OAuth error, a refused flow, a 401) marks the server `needs_auth` and the owner reconnects; one that never got an answer (the network, a 5xx) fails as `UpstreamMcp`
transport and keeps the credentials for the next call (`mcp/errors.ts` `isOAuthRejection`). Results are bounded (1 MiB,
16 MiB for App HTML); a result JSON cannot hold is `unsupported`, not over the limit.

A tool call may go 90 seconds without an answer; it asks for progress, and each progress notification the server
sends restarts that wait, up to five minutes in all, when goblin aborts the request (`withDeadline`). A missed deadline
is `UpstreamMcp` `timeout`, a caller who stopped waiting `cancelled` (`mcp/errors.ts` reads the SDK's timeout data).
Neither drops the connection; a second timeout in a row does. A call that timed out or lost its connection may still
have run, so `mcp_call` tells the model to check the server's state before calling it again.

Grants are per discovered tool (`app_mcp_grants`), toggled by the owner. A tool grant also grants its `ui://` App
resource. An App's switch (`PUT /api/mcp/app-grants`, `McpGrants.setApp`) grants an App as a whole: exactly the
tools that declare its `ui://` resource, including the ones only the App may call, and the resource itself.
Connections (`components/tool-grants.tsx`) names the App from its resource, says how many of its tools a partly
allowed App has, lists those tools under the switch, each still adjustable (an allowed tool's call policy is a select:
runs without asking, or asks first), and offers Use suggested access, Allow
all and None. Each tool carries goblin's suggestion from its annotations (`ToolView.suggested`,
`mcp/suggested-access.ts`, [ADR 0060](../adr/0060-suggested-access-from-tool-annotations.md)): `run` for one that says it
only reads and does not say it destroys, else `ask`. Use suggested access (`POST /api/mcp/:id/suggested`) allows every
tool the agent can see and turns ask first on for each one suggested to ask, never off; it shows until that state is in
place. Allow all and None send exact grants one at a time, skip (and count) a tool the server no longer offers, then
read the list again; the card says how it went. Granting a tool goblin has not listed lists the tools once more first;
taking a grant back always works, even for a tool the server dropped or while it cannot be reached. When a connection's
whole tool list differs from the last one it saw, the runtime publishes `mcp.tools` with a digest of the new list; the
workspace feed carries it (`tools`) and the web reads that connection's tools again. "Look for new tools" lists them
again over the open connection. Tool annotations from the server are shown as its claims
("says read-only") and suggest a policy, but never grant anything until the owner applies the suggestion. Disconnecting forgets credentials and keeps grants. When the model calls a tool that exists but is
not granted, nothing runs. `mcp_call` returns an error result whose details are
`{ kind: 'grant-required', connectionId, name }`, and the model is told to wait.
`mcpModelResult` details never carry a top-level `kind`, so remote content cannot forge one. The web turns that
result into an owner-only Allow card. A Topic's setup chooses servers and tools for its chats (Setup and scope, above);
that check comes first, and a helper's exclusions are forgotten with the server's grants.

### Protocol 2026-07-28: live tool lists, URL requests and step-up

goblin negotiates the protocol era (`versionNegotiation: auto`); on a 2026 connection it implements three client
features ([ADR 0042](../adr/0042-mcp-2026-client.md)).

**Live tool lists** (`mcp/tool-list.ts`). A connection's snapshot keeps its tools in place: `refreshTools` lists them
again, one flight per connection that lists once more while changes arrive, bounded as discovery is; a list that fails
or overflows is never kept in part, and the connection is marked stale so its next use opens it again. A call (or a
grant request) for a tool goblin does not list re-lists once before refusing. After a 2026 connect to a server that
advertises `tools.listChanged`, goblin holds a `subscriptions/listen` stream and re-lists on each
`notifications/tools/list_changed`. Only the owner's and the model's use holds the stream (`McpUse` `foreground`):
goblin's own background work (Events polls, notices, the channel, agent-app jobs, the skills learner) uses the
connection without it. The stream closes 60 seconds after the last foreground use (`listenIdleMs`): an open outbound
stream keeps the agent's Durable Object awake and its WebSockets from hibernating. The next foreground use lists the
tools first, then listens again, so a change made while nothing listened is not missed. A server that refuses the
stream, or ends it with a result (Sidequest does when the connection is revoked), is not asked again on that
connection; one that drops it (a deploy) or fails it on the way is asked again a minute later at the earliest. While a
2026 connection does not listen, a foreground use lists its tools again once the list is a minute old. A connection is
never closed for being idle while a request on it is under way. The SDK client's stray errors are logged by type
only.

**URL requests** (`mcp/url-asks.ts`, `mcp/url-request.ts`, `app_mcp_url_requests`). Only the model's `mcp_call`
(Goblin, a Persona, a routine run) declares URL elicitation, per request and only on a 2026 connection, and takes an
`input_required` result back (`McpConnections.callModelTool`): its own call, and the dispatch of its held call once the
owner (or their spending rule) approved it (`sendApproved`). The owner's console and Apps never declare it, so servers
answer them with a plain link. An approved dispatch that meets a URL request is spent (`completed` with no result,
`metUrlRequest`), its `ApprovalView` names the request (`urlRequest`) and the web follows its card to the request's
(`followUrlRequests`). The request's retry carries the approval (`answered`), which `heldCalls` checks as it checks the
dispatch, without claiming it again; the request's answer, not the decision, continues the turn. goblin accepts one url-mode elicitation with an
https link and no credentials; anything else is refused as `unsupported`. It keeps the call's arguments, the server's
request state (at most 64 KiB) and the link with its message, sealed, for a day or until the routine run's deadline,
and ends the turn with `{ kind: 'url-required', requestId, connectionId, name }`: the details carry neither the link nor
the message, since transcripts are indexed and approval links can hold one-time tokens. A routine run waits on the
owner and a subagent's chat stays open, as for an approval. The owner reads the request
(`GET /api/mcp/url-requests/:id`: the message, the link, its host and whether it is the server's own or a subdomain of
it) and answers it (`POST`, `accept` or `decline`): the one retry is claimed before any I/O and sends the call again
with the answer under the server's key and its request state, under the authority the call needs now. A server still
waiting makes the request pending again; its answer is kept, the connection's tools are listed again, and the outcome
goes back to the turn that asked (routine run, Persona or chat) under one operation id. A retry that may have reached
the server and did not complete is `uncertain`, and a start recovers an interrupted one as such. A Cancel stands
whether or not the server heard it. The answer goes to the tool as listed when the server asked, even after the server
dropped it (the request keeps its input schema).

**Outcomes.** A decided approval and a settled URL request go back to their chat as an outcome, never as the owner's
message (`sendOutcome`, receipt kind `mcp_outcome`, ADR 0042): authored by the connection (its label), goblin's words
for the model, then an `McpOutcome` block (`{ continuation: { kind, connectionId, name, state }, origin, result }`, the
result as untrusted data). It starts the turn and settles the asks before it, but no routine question takes it as an
answer. The web shows it as one quiet row (`parts/outcome-row.tsx`) that opens to the server's answer; it is no scroll
anchor or Turn map entry. A routine run or a Persona fork, which take plain text, gets the words and the block as JSON.
The call has run by the time its outcome goes back, so the budget never turns the decision away: when nothing can pay
for a turn (`BudgetExhausted`), the same content is kept in the chat as a passive `app.mcp_outcome` entry
(`ChatOperations.passiveWrite`, receipt kind `write:app.mcp_outcome`, data the call and its state), no run starts, the
decision answers 200, and the model reads it with the owner's next message. The operation id keeps it once however
often the decision is answered. The main chat's memory and the retrieval index keep it as they keep the input it would
have been, and while it is the transcript's newest part its row adds "goblin reads the result on your next message".

**Step-up.** The transport throws on HTTP 403 `insufficient_scope` (`onInsufficientScope: 'throw'`), which is
`ScopeRequired { connectionId, scope }` (the challenge's scope tokens, validated and capped), not `UpstreamMcp`: the
connection stays open. The model's `mcp_call` ends the turn with `{ kind: 'scope-required', connectionId, name, scope }`,
and the owner's card starts `POST /api/mcp/:id/step-up`: a fresh authorization (`forceReauthorization`) for the union of
what the connection holds, what it asked for and `offline_access` (everything offered when the held scope is not
known), opened from a real link in a new tab. Choose access, in the card's menu, reads `GET /api/mcp/:id/access`
(what a sign-in can ask for: the resource's scopes and its authorization server's together, since a resource may list
only a narrow default; and what the connection holds) and signs in with the owner's pick
(`POST /api/mcp/:id/connect { scope }`, each one offered, plus `offline_access`). A plain Connect stays narrow: the
resource's own list, else its authorization server's, with `offline_access` when offered. The
connection keeps its tokens until the new ones arrive; an abandoned step-up leaves it as it was. The owner presses
Continue in the chat once signed in.

Needs you lists open URL requests (Attention `link`, from their store) and sign-ins with more access (`access`); a
Persona's answer can hold either (`PersonaHold` kinds `url` and `access`). Each step is a flow in the run ledger, ids
and states only: `url_request` (held), then the owner's answer as `url_request_wait` (the server still waits),
`url_request_finish` (answered; `error` with the state when the retry failed or was uncertain, `refused` when expired,
`replayed` when answered again) or `url_request_cancel`; `scope_required` when a call needed more access, and `step_up`
when the owner started signing in again.
