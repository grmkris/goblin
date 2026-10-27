# The owner API

## The owner API

The browser's API is one typed Effect HttpApi contract ([ADR 0038](../adr/0038-typed-owner-api-served-by-the-agent.md)),
in `packages/contracts/src/api`: `OwnerApi`, which each workspace's agent serves, `AccountApi` (a person's) and
`WorkspaceAccountApi` (a workspace's own records), which the Worker serves, and `errors.ts`, the failure vocabulary
(`AppError`) and its envelope.

**The edge** (`http/api/edge.ts`, built once per isolate; [ADR 0089](../adr/0089-workspaces-own-agents.md)). The
account API is answered in the Worker (`http/api/account.ts`): `workspaces` for any signed-in person, and
`clientErrors`, a browser crash report, without a session. A member's request names its workspace's slug in its path
(`/w/<slug>/api/…`): the edge admits the session as below, then reads the person's membership of that workspace (a 404
when there is none), answers the workspace account API's groups itself (`members`, and `developerApps` and
`installations` for an owner or admin, and `clients`, the OAuth clients the member connected to it) and forwards every other path to the workspace's agent as `/api/…`. An
OAuth client's or an installed app's token on the same path ([ADRs 0116](../adr/0116-an-oauth-client-uses-the-owner-api-too.md),
[0118](../adr/0118-a-product-installs-into-a-workspace.md)) is admitted by the workspaces it reaches instead (a client's
grant for its person, an app's installations; `inbound/client-access.ts`, as `/mcp` admits it), and only forwarded,
an app's with no member. Nothing reaches an agent on bare `/api/…` ([ADR 0125](../adr/0125-keys-are-gone.md)): a
bearer there is no route. Every request on its way to an agent is admitted in this order, then forwarded:

1. a write whose `Origin` names another site is refused;
2. the session comes from the cookie alone, and an `Authorization` header with one is refused (`bearer_and_session`).
   An OAuth access token on `/w/<slug>/api/…`, a client's or an installed app's, is admitted instead
   (`admitClient`): its token as `/mcp` checks it with its grant
   ([ADR 0114](../adr/0114-one-grant-for-every-credential.md)), refused with a cookie (`bearer_and_session`), the
   workspace at the slug among those it reaches now (one of a client's person's workspaces outside its grant is
   `AccessInsufficient` with the link that adds it, [ADR 0127](../adr/0127-a-client-may-ask-for-a-workspace-its-person-belongs-to.md); any other is
   `NotFound` `workspace`), never the workspace account API
   (`Forbidden` `credential`), and only for an endpoint annotated `EndpointAccess` whose level and extra its grant
   holds (`endpointAccess`; an endpoint without one is `Forbidden` `credential`, a grant that lacks them
   `AccessInsufficient` with the widening link, and what a client's person's role could never hold `Forbidden`
   `role`). It needs no CSRF header, and it is forwarded as the request's credential in `x-goblin-caller` (ADR 0086),
   which `/mcp` also sets: its kind (`client` or `app`), id and name, its grant's id, level, extras, end and origins,
   and in this workspace whether its Topics, Personas and connections are all or a list, with their generation (never
   the lists). A client's person is forwarded as the member too, whose role the agent holds it to; an app has none;
3. every write needs the app's own `Origin` and `x-goblin-csrf: 1` (`http/csrf.ts`), which the web sends on every write;
4. a body is capped at 64 KiB, except a send's and a thread operation's, at 1 MiB (an AG-UI `RunAgentInput`, which a
   stock client sends with the whole conversation, [ADR 0111](../adr/0111-agui-run-input-is-the-send.md)), and file
   bytes, which stream through to the agent's own limits;
5. `AGENTS.getByName(workspaceId).fetch` gets the request with only `content-type`, `content-length`, `accept`,
   `last-event-id`, `x-goblin-request`, `x-goblin-operation` and `x-mcp-caller`, plus the edge's reference in
   `x-goblin-ref` (the request's cf-ray, or a random id where there is none), `x-goblin-forwarded: owner` and who it
   comes from: the member (`x-goblin-member`: their user ID, role, name and whether the workspace is shared, ADR
   0094) and the credential (`x-goblin-caller`). Cookies and authorization stay at the edge. Only an `/api/*` path that is not an account API's is forwarded, as the parsed URL
   names it; anything else is a 404.

Every answer carries `x-goblin-ref`, `cache-control: no-store` and `nosniff`. Each failed one, the edge's refusals and
the agent's answers alike, is one `http.failure` log line: route template, method, status, code, reference, the
browser's request and operation ids, and the agent; never a body.

**The agent** (`PersonalAgent.onRequest`) answers with `AgentHttp` (`http/api/server.ts`): one router over every group's
handlers of the owner and internal APIs (`http/api/groups.ts`), built once inside the agent's runtime as one of its
layers, never at module level.
Each group's handlers (`HttpApiBuilder.group`) live in their area (`<area>/api.ts`) and read the agent's services
from context. Owner admission (the `OwnerAdmission` middleware, `http/api/middleware.ts`) admits every request
before its handler, and before its body is decoded. A forward that names neither a member nor a caller, or names one in
a header that does not decode, is `Unauthenticated` (`principal`), never taken for the owner. A member below the
endpoint's `EndpointRole` (`admin` for what changes the agent's authority, ADR 0093, and what it works with: Personas,
a Topic's setup, routine writes, ADR 0098; and every change to a Topic, its name, archiving and whether it is the hub
included, ADR 0115) is `Forbidden` (`role`), and so is an OAuth client acting for one. Where one endpoint serves both,
`requireAdminFor` (`grants/policy.ts`) refuses a member the admin's part: a Topic's description, guidance or setup on
create, and Undo of a receipt whose change took an admin; `requireAccessFor` asks a
credential's grant for the same parts (`manage` for guidance, `setup` for a setup). The agent's own tools for
those changes refuse on a member's turn the same way (ADR 0099, `pi/asker.ts`): each admission records the role of the
member who asked on its receipt, and a tool reads its run's inputs back to them. A member's request gets a
grant of resident authority, except where an endpoint is
annotated `GrantsResident: false` (`POST /api/agent/resident`, the event streams, the entries read, the files group and the
OAuth callback). A request from a credential (ADRs 0086, 0114, 0116, 0118: an OAuth client or an installed app, on
`/mcp` or a workspace's path) never grants it; owner admission admits it only to an endpoint whose `EndpointAccess` its grant holds (else `credential` or
`AccessInsufficient`), for a client also only where its person's role holds it (`ROLE_POWER`, else `role`), refuses a
grant past its end (`grant_expired`), counts its requests per minute (600, ADR 0085; past them `rate_limited` with
`retryAfter`, which the edge answers with `Retry-After`) and syncs the agent's mirror of its lists when the forwarded
generation moved (`Grants.sync`, `grants/service.ts`). Past admission a credential reaches what its grant reaches
(`grants/policy.ts`, the `app_grant_reach` mirror): its lists hold only what it reaches, and inspection sees only the
run events of those chats (ADR 0084); an app's Topics are sealed like any other, named as made by it (`madeBy`, for
display), and its messages carry `[from server <app name>]`, its turns doing what its grant allows (ADR 0115). It annotates the request's logs with `goblin.rpc`
(`<group>.<endpoint>`), `goblin.operation` and `ref`, and stamps `ref` on every typed failure.

| Group | Paths under `/api` | Handlers |
| --- | --- | --- |
| `conversations` | `/conversations`, `/conversations/:id`, and under it `messages` (a send as AG-UI's `RunAgentInput`, answered with Pi's receipt, or with its run's AG-UI events when asked for `text/event-stream`, ADR 0111, [driving a chat](streams.md#driving-a-chat)), `threads`, `move`, `stop`, `sends/:operationId` (how one send stands, ADR 0119), `queue`, `read`, `composer`, `history` (older pages, as AG-UI messages), `entries`, `sources`, `stream` (its AG-UI events as server-sent events, every one to every reader that reaches the chat, [chat streams](streams.md)) | `chats/api.ts` |
| `inspect` | `GET /inspect/conversations`, `/inspect/conversation`, `/inspect/turns`, `/inspect/turn`, `/inspect/problems`, `/inspect/flows`, `/inspect/details` | `inspect/api.ts` |
| `events` | `GET /events`, `POST /events/subscribe`, `/events/unsubscribe`, `/events/poll` ([published events](published-events.md), a credential's `read`, ADR 0112) | `publish/api.ts` |
| `access` | `GET /access` (a credential's own grant as `AccessSummary`, ADR 0114) | `access/api.ts` |
| `topics` | `/topics`, `/topics/:id`, `/topics/:id/setup` | `topics/api.ts` |
| `setup` | `GET /setup/catalog` | `setup/api.ts` |
| `personas` | `/personas`, `/personas/:id` | `personas/api.ts` |
| `organize` | `/organize/:id/undo` | `organize/api.ts` |
| `mcp` | `/mcp/servers`, `/mcp/suggested`, `/mcp/catalog`, `/mcp/registries`, `/mcp/registries/remove`, `/mcp/grants`, `/mcp/grants/batch`, `/mcp/ask-first`, `/mcp/skills`, `/mcp/app-grants`, `/mcp/approvals/:id`, `/mcp/url-requests/:id`, `/mcp/oauth/callback`, and `/mcp/:id/` `tools`, `events`, `connect`, `step-up`, `disconnect`, `remove`, `tools/call`, `resources/read` (a credential's `setup` reads the servers and grants, and with `manage` adds, renames, signs in, disconnects and removes a connection and sets its grants and skills, within its reach, ADR 0117) | `mcp/servers/api.ts` |
| `resident` | `/agent/resident` | `mcp/resident-api.ts` |
| `agent` | `/agent/usage`, `/agent/model`, `/agent/model-endpoint`, `GET /models` | `routines/agent-api.ts` |
| `memory` | `/agent/memory` | `memory/api.ts` |
| `routines` | `/routines`, `/routines/settings`, `/routines/:id`, and under it `confirm`, `pause`, `run`, `runs` | `routines/api.ts` |
| `apps` | `/apps`, `/apps/:id`, and under it `launch`, `state`, `call`, `diagnostics` | `apps/api.ts` |
| `agentApps` | `/agent-apps`, `/agent-apps/:name` | `agent-apps/api.ts` |
| `workspace` | `GET /workspace/events` (SSE) | `workspace/api.ts` |
| `files` | `GET /files`, `GET`/`PUT`/`DELETE /files/content` | `files/api.ts` |
| account (Worker) | `clients`: `/clients`, `/clients/:clientId`; `grants`: `GET /grants/:id/terms`, `PUT /grants/:id`, `GET /clients/:clientId/terms`, `PUT /clients/:clientId/grant` (ADR 0114); `members`; `developerApps`: `/developer/apps`, `/developer/apps/:clientId`, `/developer/apps/:clientId/rotate` (a new client secret, ADR 0118); `installations`: `/installations`, `/installations/:id` (`PATCH` gives an installation's grant new terms); `install`: `/install/:clientId`; `clientErrors`: `/client-errors` | `http/api/account.ts`, `auth/installs.ts` |

What is not JSON in and out is served through HttpApi's raw handlers, all annotated `GrantsResident: false`: the two
event streams (SSE: the workspace feed and a chat's AG-UI stream, which a credential reads too), the owner's file bytes (streamed both ways, never buffered), and `mcp.oauthCallback`, a redirect
to Connections that carries `ref` when it failed. A streamed answer owns its body, past the request's scope. Any path
no endpoint names is a 404 in the envelope.

A failure answers the envelope `{ error: { code, message, recovery?, …safe fields, ref? } }`: `code` is the
`AppError` tag in lower_snake_case, which the typed client decodes back into the class, `message` and `recovery` are
fixed copy (`ERROR_COPY`), and the safe fields are the ones the UI uses (`reason`, `what`, `connectionId`, `name`,
`state`, `limit`, `resetsAt`, `rpcCode`, and `problems` of an MCP tool call whose arguments do not fit its schema,
`invalid_arguments`). A remote server's own words (`UpstreamMcp.serverMessage`, ADR 0092) never enter the envelope.
Of a request that does not decode, a path parameter that does
not parse is 404, and a body, query or header that does not match is 400. A
failure from stored data, a response that does not encode, or a defect is a 500 `Internal`, reported with its stack
locations and never its message. The Worker's own routes (`/mcp`'s failures aside) answer the same envelope.

Callers that are not the owner's browser reach the agent through its internal API (`InternalApi`, `/internal`, exported
only from `@goblin/contracts/internal`), which the Worker calls on the agent's stub with a typed client
(`inbound/client.ts`) after its own check of the caller (a bearer token, a hook's route token, a file link's token):
`inspect` (inbound `/mcp`), `mcpEvents` (the Events hook), `linkedFile` (a file link, ADR 0070) and
`publish.terminate` (`POST /internal/publish/terminate`, ADR 0112), which the account API calls before it uninstalls
or narrows an installation, deletes an app, or revokes an OAuth client, so the holder's Events leases end with
`terminated` first. Its gate (`InternalGate`, `http/api/middleware.ts`)
refuses a request carrying the owner forward's mark; it never grants resident authority. One Durable Object RPC
method remains, `deleteAgentData` (account deletion): Workers RPC drops custom error classes, so it returns an encoded
`RpcResult` (`http/rpc.ts`) that the Worker unwraps.

### In the browser

`lib/api.ts` builds two typed clients over the query bridge (`lib/query/api-query.ts`, a port of myapps'
`@myapps/query` with its provenance in `lib/query/PROVENANCE.md`): `owner` (`OwnerApi`) and `account` (`AccountApi`).
Every request carries a fresh `x-goblin-request` id, every write `x-goblin-csrf: 1`, and a write run with
`withOperation` its `x-goblin-operation`. Besides them, only the file bytes (`lib/files.ts`), the two event streams
(`lib/event-streams.ts`) and Better Auth's client (`/api/auth`) reach `/api`. Server data follows myapps ADR 0013, as
[the web's instructions](../../apps/web/AGENTS.md#data-layer) spell out:

- One `src/<feature>/queries.ts` per feature holds its `owner.apiQuery` and `owner.apiMutation` factories and its
  keys (`<feature>Keys`, rooted at the feature's name); the hooks over them live in `src/<feature>/hooks.ts`. A
  mutation's callbacks reach the cache through TanStack's `context.client`, and its `onSuccess` returns its
  invalidation.
- The `QueryClient` is made per router (`router.tsx`): data stays fresh for 30 seconds, only a retryable failure is
  retried, and a read that finds the session gone clears the cache and goes to sign-in.
- Owner pages render inside `OwnerGate` (sign-in on the page), not a signed-in layout. A route loader may prime a
  read with `primeOwnerRead` (`lib/prime.ts`), which runs ahead of the gate and decides nothing. Components read with
  `useSuspenseQuery` inside a `QueryBoundary` (`lib/query/query-boundary.tsx`), which keeps a failure inline with its
  reference and a retry; a section that reads with `useQuery` shows `QueryError`.
- The workspace feed writes into the same cache (`lib/workspace/`): each slice (conversations, activity, apps, topics,
  personas, invocations, receipts) is a query under `['workspace', slice]` that never goes stale, filled from
  the stream's snapshot and changes, and a change that makes another feature's reads stale invalidates them through one
  map (`lib/workspace/invalidations.ts`). The conversation stream stays a dedicated SSE store that only invalidates.
- A failure reads through `messageOf` or `describeError` (`lib/query/app-error.ts`) and quotes its reference. A route
  that fails shows `ReportedRouteError`, which reports a defect as a crash (see Logs, failures and references).

The web's tests serve the real contract in memory (`fakeHttpApi`, `test/query/testing.ts`).
