# The owner API

## The owner API

The browser's API is one typed Effect HttpApi contract ([ADR 0038](../adr/0038-typed-owner-api-served-by-the-agent.md)),
in `packages/contracts/src/api`: `OwnerApi`, which each user's agent serves, `AccountApi`, which the Worker serves,
and `errors.ts`, the failure vocabulary (`AppError`) and its envelope.

**The edge** (`http/api/edge.ts`, built once per isolate). The account API's groups are answered in the Worker
(`http/api/account.ts`): `clients` and `keys` for any signed-in account (never for an API key), and `clientErrors`, a
browser crash report, without a session. Every other `/api/*` request is admitted in this order, then forwarded:

1. a write whose `Origin` names another site is refused;
2. the session comes from the cookie alone, and any `Authorization` header but a server API key is refused. A
   `Bearer gbk_…` key ([ADR 0081](../adr/0081-api-keys-and-the-same-operations-over-mcp.md)) is admitted instead of a
   session: verified in the auth D1, refused with a cookie or an `Origin`, and only for an endpoint annotated
   `ApiKeyScope` with a scope the key holds (`keyScopes`); it needs no CSRF header, and its grant (id, scopes, server
   ceiling) is forwarded in `x-goblin-key`;
3. every write needs the app's own `Origin` and `x-goblin-csrf: 1` (`http/csrf.ts`), which the web sends on every write;
4. a body is capped at 64 KiB, except file bytes, which stream through to the agent's own limits;
5. `AGENTS.getByName(userId).fetch` gets the request with only `content-type`, `content-length`, `accept`,
   `last-event-id`, `x-goblin-request`, `x-goblin-operation` and `x-mcp-caller`, plus the edge's reference in
   `x-goblin-ref` (the request's cf-ray, or a random id where there is none) and `x-goblin-forwarded: owner`. Cookies
   and authorization stay at the edge. Only an `/api/*` path that is not the account API's is forwarded, as the parsed
   URL names it; anything else is a 404.

Every answer carries `x-goblin-ref`, `cache-control: no-store` and `nosniff`. Each failed one, the edge's refusals and
the agent's answers alike, is one `http.failure` log line: route template, method, status, code, reference, the
browser's request and operation ids, and the agent; never a body.

**The agent** (`PersonalAgent.onRequest`) answers with `AgentHttp` (`http/api/server.ts`): one router over every group's
handlers of the owner and internal APIs (`http/api/groups.ts`), built once inside the agent's runtime as one of its
layers, never at module level.
Each group's handlers (`HttpApiBuilder.group`) live in their area (`<area>/api.ts`) and read the agent's services
from context. Owner admission (the `OwnerAdmission` middleware, `http/api/middleware.ts`) admits every request
before its handler, and before its body is decoded: a renewal of resident authority, except where an endpoint is
annotated `RenewsResident: false` (`POST /api/agent/resident`, the event streams, the entries read, the files group and the
OAuth callback). A request a key sent never renews it; owner admission checks the key's scope again, and the Topics,
conversations, Personas and inspection handlers confine a key to what it made (`keys/policy.ts`, `app_key_reach`): its lists hold only its own, and inspection sees only its own chats' run events (ADR 0084). It annotates the request's logs with `goblin.rpc`
(`<group>.<endpoint>`), `goblin.operation` and `ref`, and stamps `ref` on every typed failure.

| Group | Paths under `/api` | Handlers |
| --- | --- | --- |
| `conversations` | `/conversations`, `/conversations/:id`, and under it `messages`, `threads`, `move`, `stop`, `queue`, `read`, `composer`, `snapshot`, `history`, `sources`, `events` (SSE) | `chats/api.ts` |
| `inspect` | `GET /conversations/:id/details`, `GET /inspect/turns`, `/inspect/turn`, `/inspect/problems`, `/inspect/flows` | `inspect/api.ts` |
| `topics` | `/topics`, `/topics/:id`, `/topics/:id/setup` | `topics/api.ts` |
| `setup` | `GET /setup/catalog` | `setup/api.ts` |
| `personas` | `/personas`, `/personas/:id` | `personas/api.ts` |
| `organize` | `/organize/:id/undo` | `organize/api.ts` |
| `mcp` | `/mcp/servers`, `/mcp/suggested`, `/mcp/catalog`, `/mcp/registries`, `/mcp/registries/remove`, `/mcp/grants`, `/mcp/grants/batch`, `/mcp/ask-first`, `/mcp/skills`, `/mcp/app-grants`, `/mcp/approvals/:id`, `/mcp/url-requests/:id`, `/mcp/oauth/callback`, and `/mcp/:id/` `tools`, `events`, `connect`, `step-up`, `disconnect`, `remove`, `tools/call`, `resources/read` | `mcp/servers/api.ts` |
| `resident` | `/agent/resident` | `mcp/resident-api.ts` |
| `agent` | `/agent/usage`, `/agent/model`, `/agent/model-endpoint`, `GET /models` | `routines/agent-api.ts` |
| `memory` | `/agent/memory` | `memory/api.ts` |
| `routines` | `/routines`, `/routines/settings`, `/routines/:id`, and under it `confirm`, `pause`, `run`, `runs` | `routines/api.ts` |
| `apps` | `/apps`, `/apps/:id`, and under it `launch`, `state`, `call`, `diagnostics` | `apps/api.ts` |
| `agentApps` | `/agent-apps`, `/agent-apps/:name` | `agent-apps/api.ts` |
| `workspace` | `GET /workspace/events` (SSE) | `workspace/api.ts` |
| `files` | `GET /files`, `GET`/`PUT`/`DELETE /files/content` | `files/api.ts` |
| account (Worker) | `clients`: `/clients`, `/clients/:clientId`; `keys`: `/keys`, `/keys/:keyId` (`PATCH` changes a key's scopes, ADR 0084); `clientErrors`: `/client-errors` | `http/api/account.ts` |

What is not JSON in and out is served through HttpApi's raw handlers, all annotated `RenewsResident: false`: the two
event streams (SSE), the owner's file bytes (streamed both ways, never buffered), and `mcp.oauthCallback`, a redirect
to Connections that carries `ref` when it failed. A streamed answer owns its body, past the request's scope. Any path
no endpoint names is a 404 in the envelope.

A failure answers the envelope `{ error: { code, message, recovery?, …safe fields, ref? } }`: `code` is the
`AppError` tag in lower_snake_case, which the typed client decodes back into the class, `message` and `recovery` are
fixed copy (`ERROR_COPY`), and the safe fields are the ones the UI uses (`reason`, `what`, `connectionId`, `name`,
`state`, `limit`, `resetsAt`, `rpcCode`). Of a request that does not decode, a path parameter that does
not parse is 404, and a body, query or header that does not match is 400. A
failure from stored data, a response that does not encode, or a defect is a 500 `Internal`, reported with its stack
locations and never its message. The Worker's own routes (`/mcp`'s failures aside) answer the same envelope.

Callers that are not the owner's browser reach the agent through its internal API (`InternalApi`, `/internal`, exported
only from `@goblin/contracts/internal`), which the Worker calls on the agent's stub with a typed client
(`inbound/client.ts`) after its own check of the caller (a bearer token, a hook's route token, a file link's token):
`ask`, `recent` and `inspect` (inbound `/mcp`), `mcpEvents` (the Events hook) and `linkedFile` (a file link, ADR 0070). Its gate (`InternalGate`, `http/api/middleware.ts`)
refuses a request carrying the owner forward's mark; it never renews resident authority. One Durable Object RPC
method remains, `deleteAgentData` (account deletion): Workers RPC drops custom error classes, so it returns an encoded
`RpcResult` (`http/rpc.ts`) that the Worker unwraps.

### In the browser

`lib/api.ts` builds two typed clients over the query bridge (`lib/query/api-query.ts`, a port of myapps'
`@myapps/query` with its provenance in `lib/query/PROVENANCE.md`): `owner` (`OwnerApi`) and `account` (`AccountApi`).
Every request carries a fresh `x-goblin-request` id, every write `x-goblin-csrf: 1`, and a write run with
`withOperation` its `x-goblin-operation`. Besides them, only the file bytes (`lib/files.ts`), the two event streams
and Better Auth's client (`/api/auth`) reach `/api`. Server data follows myapps ADR 0013, as
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
