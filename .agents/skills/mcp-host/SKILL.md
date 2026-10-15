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
- A result's links, embedded resources and audio are kept in the owner's files by `materialize` (`mcp/content.ts`,
  ADR 0065), never as bytes in the conversation: a public https link is fetched with no credentials (`isPublicHttps`
  for it and every redirect; `http:` and private addresses are refused), a non-web scheme only through
  `resources/read` under the owner's resource grant, and a block that cannot be kept is a note, never a failed call.
  Record a result's content with `recordedContent` (links without query or fragment) wherever it reaches a transcript
  or an outcome.
- Inbound tokens must verify locally, name `/mcp` as audience, come from an enabled client with live owner consent.
  An inbound client's messages go into main, labelled with its name.
- Events (`mcp/events.ts`, ADR 0011) require resident authority and an exact server/name/canonical-arguments owner
  grant through the originating endpoint-bound connection. A server offers Events by top-level `capabilities.events`
  (decoded at the authenticated SDK fetch seam, which strips it) or by the `io.modelcontextprotocol/events` extension,
  which goblin declares too (ADR 0041). Signed controls have separate schemas; payloads never grant or become
  instructions.
- Telegram (`channel/`, ADRs 0009, 0055) rides Events only, subscribed with `{ chat: 'all' }` when the grant reaches
  every chat (the DM's otherwise); each chat's route is in `channel/routes.ts`. Its tool and Event
  names are mygram's or mysi's spelling, read from the connection (`telegramTools`, `telegramEvent`). Preserve sanitized
  `telegram-tg-<update>` and reply operation ids; fence old cursor writes only after both leases confirm. Hooks persist
  receipts before asynchronous dispatch; accepted submissions are distinct from external delivery.
- Sources (`sources/`, ADR 0066) are how any server's events carry the owner's own messages: an owner-confirmed setup
  of JSON pointers and whole-value argument templates (`SourceSetup`), never a server's name. Confirmation grants the
  wake selector and the read and reply tools, subscribes `source:<id>` (handler `source-wake`) and binds the Source to
  the endpoint and its tools' grant versions; a change pauses it for review. Only messages the confirmed speaks-for-me
  rule matches become owner turns, with no more authority than the app's; everything else stays untrusted data.
  Replies are goblin's calls under the owner's grant (`caller: 'model'`), one operation id a piece.
- Notify me via (`sources/notify.ts`, ADRs 0066, 0070) is the one way goblin's own notices leave: a routine's notice
  copies and the apps' `notify` power fill its whole-value template (`sendThroughSink`), as goblin's call under the
  owner's grant, with resident authority and the sink's revision checked again right before the call leaves. A file
  goes to a server as a `file_link` URL in a tool's arguments (MCP has no upload); the receiving tool's grant and Ask
  first decide whether it is sent.
- The shelf (`mcp/suggested.ts`, ADRs 0052, 0061) is data, one endpoint per entry on every deployment (`MCP_SHELF`
  replaces or adds entries): one mysi connection (`mysi.lol/mcp?codemode=off`) instead of the separate my* servers,
  publishing (Cloudflare), then servers that need no sign-in in groups; re-probe one with an `initialize` before
  adding it. mysi names
  tools `<service>_<tool>` and Events `<service>.<event>`: check an app's tool or Event name only through
  `packages/contracts/src/service-names.ts`, never with a bare string. `mcp_list` lists a connection with many such
  tools by service (`service`, `query`).
- Pinning an App adds no grant. Every owner write, `/api/mcp/` included, needs the app's Origin and the CSRF header at
  the Worker's edge (ADR 0038); the bridge remains bound to the originating server.
- The owner's MCP endpoints are the owner API's `mcp` and `resident` groups (`packages/contracts/src/api/mcp.ts` and
  `resident.ts`, handlers in `mcp/api.ts` and `mcp/resident-api.ts`) over the services in `mcp/service.ts` (`McpServers`,
  `McpGrants`, `McpConnections`, `Approvals`, `Events`, `Resident`). An App's own calls carry `x-mcp-caller: app`,
  which the edge forwards and the contract reads, so they are held to the App's grants. The OAuth callback is the
  `mcp` group's raw `oauthCallback` (`GET /api/mcp/oauth/callback`), a redirect to Connections, with `ref` when it
  failed.
- Inbound `/mcp` reaches the agent through its internal API (`@goblin/contracts/internal`): `ask`, `recent`, and
  `inspect` for a token that holds `goblin:inspect`, called on the stub through `inbound/client.ts`.
- Fixture tests (`test/mcp/`) prove protocol behaviour; the real behaviour of mysi and its apps (myplan, mytab and the
  rest) is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routine confirmation grants only the reviewed exact Event selector. Subscribe validates arguments against the installed producer descriptor schema. Routine consumers share leases, retire by revision and ACK only after run/pending/skip metadata is durable; gap/termination controls do not authorize a model turn.
- Connections (ADR 0041): one server may have several connections, each with the owner's label (`mcp/labels.ts`,
  unique ignoring case; DCR `client_name` is plain "goblin", ADR 0062) and its own webhook URL
  (`/hooks/mcp-events/<user>/<connection>/<token>`). Model text names one as `"<label>" (<id>)` (`named`); labels and
  notice text never enter telemetry. A connection that sends events offers them (`ServerView.events`: open, dismissed,
  done; `mcp/events/offers.ts`); `mcp_list` shows its first 64 event streams as untrusted data when asked
  (`events: true`). A descriptor's `title` and `_meta.suggest` are read leniently, field by field
  (`eventSuggestion`): suggestions that pre-select in the owner's picker and never grant or confirm a selector. `mcp_list` lists a connection's tools in brief (name, one-line description, flags that differ) and
  gives input schemas only for the tools named in `tools`: its result stays in the model's context. Its list of
  connections puts connected ones first, so a configured connection never signed in does not win.

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

- Every server alike (ADR 0063): no code knows a server by its endpoint or name, holds a profile, recommended grants,
  a status line, a spending rule or a top-up, or reads an amount from a call's arguments. Suggested access (ADR 0060),
  the persisted App entrypoint (`mcp/entrypoints.ts`), Choose access's scope union and the data shelf cover every
  server; a tool that spends is controlled by Ask first. The skill learner writes drafts to the owner's files and calls
  no server's tool. Left for later phases: the Telegram channel's names (above) and the Apps host's MyPlan
  question-answer message. Never add a server-specific branch: give the owner a choice that works for any server.

- MCP Apps: goblin declares `io.modelcontextprotocol/ui` (`text/html;profile=mcp-app`) to every server. An App's HTML
  is read from a resource's `text` or base64 `blob` (decoded and bounded in `mcp/app-html.ts`, strict UTF-8). A call
  held for approval, or a finished URL request, keeps its App when it completes (`mcp/kept-app.ts`), and the App
  launches with the real result, not the transcript's placeholder.
