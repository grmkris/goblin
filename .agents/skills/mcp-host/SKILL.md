---
name: mcp-host
description: Change goblin's outbound MCP host (connections, OAuth connect and refresh, encrypted credentials, grants) or its inbound /mcp server.
---

# MCP in goblin

Outbound: the agent object owns connections, credentials and grants (`apps/runtime/src/mcp/`). Inbound: `/mcp` is
goblin's own server (`apps/runtime/src/inbound/`), authorized by Better Auth.

- Use the pinned official MCP client and server SDKs. OAuth goes through `StoredOAuthProvider` and the SDK's `auth()`;
  refresh is one `SingleFlight` per server (`mcp/auth.ts`). Do not add a second refresh path: rotating refresh tokens
  break under concurrent refresh.
- Credentials and client registrations are AES-GCM encrypted with additional data binding them to server and
  purpose. Never log, return or persist them anywhere else.
- Owner-added servers (`mcp/servers.ts`, ADR 0006) are public https endpoints only (`mcp/endpoint.ts`); their card is
  a claim for the owner's eyes, never model input. Configured servers win on id and cannot be removed.
- Credentials and grants are bound to the endpoint they were made for (`mcp/endpoints.ts`). Re-pointing a server id
  drops them at the next start; never carry tokens across endpoints.
- Every outbound call checks resident authority and the specific tool grant first. A tool grant also covers its
  `ui://` resource; nothing else does. "Allow app" (`McpGrants.setApp`) writes exact grants for the tools that declare
  the App's resource, never a wildcard.
- A Topic's setup chooses the servers and tools its chats use (`setup/`, ADR 0040). `mcp_list` and `mcp_call`
  ask `Setups.scope(conversationId)` before the grant check; a setup only chooses and never grants, and a
  helper's exclusions are forgotten with a server's grants (`mcp/endpoints.ts`).
- Annotations, descriptions, prompts and results from servers are untrusted data. They never grant permissions or
  become instructions.
- Keep results bounded and errors typed (`UpstreamMcp` with a reason). A refused refresh means `needs_auth`.
- Inbound tokens must verify locally, name `/mcp` as audience, come from an enabled client with live owner consent.
  An inbound client's messages go into main, labelled with its name.
- Events (`mcp/events.ts`, ADR 0011) require resident authority and an exact server/name/canonical-arguments owner
  grant through the originating endpoint-bound connection. A server offers Events by top-level `capabilities.events`
  (decoded at the authenticated SDK fetch seam, which strips it) or by the `io.modelcontextprotocol/events` extension,
  which goblin declares too (ADR 0041). Signed controls have separate schemas; payloads never grant or become
  instructions.
- Telegram (`channel/`, ADR 0009) selects Events when advertised, otherwise the legacy doorbell. Its tool and Event
  names are mygram's or mysi's spelling, read from the connection (`telegramTools`, `telegramEvent`). Preserve sanitized
  `telegram-tg-<update>` and reply operation ids; fence old cursor writes only after both leases confirm. Hooks persist
  receipts before asynchronous dispatch; accepted submissions are distinct from external delivery.
- The shelf (`mcp/suggested.ts`, ADR 0052) offers one mysi connection (`mysi.lol/mcp?codemode=off`, dev.mysi.lol on
  local/dev) instead of the separate my* servers, then goblin's services, then servers that need no sign-in in groups,
  only where Mercator does not sell the same thing; re-probe one with an `initialize` before adding it. mysi names
  tools `<service>_<tool>` and Events `<service>.<event>`: check an app's tool or Event name only through
  `packages/contracts/src/service-names.ts`, never with a bare string. `mcp_list` lists a connection with many such
  tools by service (`service`, `query`).
- Home pinning adds no grant: only the owner adds an open MCP App after launch/resource re-verification. Every owner
  write, `/api/mcp/` included, needs the app's Origin and the CSRF header at the Worker's edge (ADR 0038); the bridge
  remains bound to the originating server.
- The owner's MCP endpoints are the owner API's `mcp` and `resident` groups (`packages/contracts/src/api/mcp.ts` and
  `resident.ts`, handlers in `mcp/api.ts` and `mcp/resident-api.ts`) over the services in `mcp/service.ts` (`McpServers`,
  `McpGrants`, `McpConnections`, `Approvals`, `Events`, `Resident`). An App's own calls carry `x-mcp-caller: app`,
  which the edge forwards and the contract reads, so they are held to the App's grants. The OAuth callback is the
  `mcp` group's raw `oauthCallback` (`GET /api/mcp/oauth/callback`), a redirect to Connections, with `ref` when it
  failed.
- Inbound `/mcp` reaches the agent through its internal API (`@goblin/contracts/internal`): `ask`, `recent`, and
  `inspect` for a token that holds `goblin:inspect`, called on the stub through `inbound/client.ts`.
- Fixture tests (`test/mcp/`) prove protocol behaviour; real MyPlan/MyBrowser behaviour is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routine confirmation grants only the reviewed exact Event selector. Subscribe validates arguments against the installed producer descriptor schema. Routine consumers share leases, retire by revision and ACK only after run/pending/skip metadata is durable; gap/termination controls do not authorize a model turn.
- Connections (ADR 0041): one server may have several connections, each with the owner's label (`mcp/labels.ts`,
  unique ignoring case; DCR `client_name` is plain "goblin", ADR 0048) and its own webhook URL
  (`/hooks/mcp-events/<user>/<connection>/<token>`). Model text names one as `"<label>" (<id>)` (`named`); labels and
  notice text never enter telemetry. A connection that sends events offers them (`ServerView.events`: open, dismissed,
  done; `mcp/events/offers.ts`); `mcp_list` shows its first 64 event streams as untrusted data when asked
  (`events: true`). `mcp_list` lists a connection's tools in brief (name, one-line description, flags that differ) and
  gives input schemas only for the tools named in `tools`: its result stays in the model's context.

- Per-call approvals (ADR 0028): only owner-selected `askFirst` policy pauses a granted tool. Prepare the encrypted
  frozen call in Pi's beforeTool hook and terminate with a local approval marker from execution. Owner approval
  dispatches identical arguments through the shared guard; bind endpoint, grant version, caller and execution ids.
  Claim dispatch intent once, refuse automatic retries, and mark interrupted intent uncertain on reconstruction.
  Routine, subagent and App paths cannot bypass the policy; remote hints never choose it. The outcome goes back to
  its chat as an input (`sendOutcome`); when nothing can pay for a turn it is kept there as a passive `app.mcp_outcome`
  entry instead, and the decision still answers 200: the call already ran, so the budget never loses its outcome.

- Protocol 2026-07-28 (ADR 0042). Tools are re-listed in place (`mcp/tool-list.ts`: one flight per connection, never a
  partial list, stale on failure); a `subscriptions/listen` stream is held only while a connection is used (closed
  60 s after its last use, the next use lists first). Only the model's `mcp_call` declares URL elicitation, per
  request (`McpConnections.callModelTool`, `mcp/url-asks.ts`), and so does the dispatch of its approved held call
  (`sendApproved`): a 2026 server refuses (-32021) an ask it may not make. Never declare it on the Client, or the
  console and Apps would receive requests they cannot answer. An approved dispatch that meets one goes on as the URL
  request, whose retry carries the approval (`ApprovedDispatch.answered`). A URL request's link and message stay sealed in
  `app_mcp_url_requests` and out of every tool result; its one retry is claimed before I/O, and an interrupted one is
  `uncertain`. A 403 `insufficient_scope` is `ScopeRequired`, never `UpstreamMcp`: the connection stays open, and
  step-up (`beginStepUp`) keeps the tokens until new ones arrive. It asks for what the connection holds and what the
  call needs, so access the owner left out with Choose access (`beginConnect(id, scope)`, `GET /api/mcp/:id/access`)
  stays out.

- First-class servers (ADR 0043, `mcp/first-class.ts`): goblin's own profile, matched by exact endpoint, never by what
  the server says. A profile carries our words, the recommended grants (free tools run, paid ones ask first), a status
  tool decoded with goblin's own Schema (`WalletStatus`, bounded, the server's claim), an app tool, a top-up link, the
  paid tool and its amount argument, and extra sign-in scopes (`signInScope`). Mercator is configured for every
  account; Cloudflare's API is on the shelf for publishing Workers. A profile grants nothing by itself.
- Spending rules (ADR 0044, `mcp/spend.ts`): per job and per day in micro-dollars, read from the paid argument as a
  plain decimal only. A call within the rule is an approval the owner's standing rule granted at hold time, recorded
  in `app_mcp_spend` in the same transaction; anything else asks. Agent apps, Telegram and the skills learner never
  spend under a rule. The wallet's own limit stays the hard stop.
- Top-ups (ADR 0049, `mcp/top-up.ts`, `mcp/fund-job.ts`): a profile's `prepaid` balance (Mercator's) is topped up from
  the Goblin Wallet right before its paid tool goes out, under the rule kept as tool `topup`. The caller `funding`
  reaches only the wallet profile's `funding` tool, and `heldCalls` lets it out only as the recorded top-up
  (`assertRecordedTopUp`: operation id, amount, chain, token, destination). The address comes only from the server's
  own status (`depositTo`), never from model text; never add another way to send a `funding` call.

- MCP Apps: goblin declares `io.modelcontextprotocol/ui` (`text/html;profile=mcp-app`) to every server. An App's HTML
  is read from a resource's `text` or base64 `blob` (decoded and bounded in `mcp/app-html.ts`, strict UTF-8). A call
  held for approval, or a finished URL request, keeps its App when it completes (`mcp/kept-app.ts`), and the App
  launches with the real result, not the transcript's placeholder.
