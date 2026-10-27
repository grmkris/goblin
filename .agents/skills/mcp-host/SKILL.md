---
name: mcp-host
description: Change goblin's outbound MCP host (connections, OAuth connect and refresh, encrypted credentials, grants) or its inbound /mcp server.
---

# MCP in goblin

Outbound: the agent object owns connections, credentials and grants (`apps/runtime/src/mcp/`). Inbound: `/mcp` is
goblin's own server (`apps/runtime/src/inbound/`), authorized by Better Auth.

- Use the pinned official MCP client and server SDKs. OAuth goes through `StoredOAuthProvider` and the SDK's `auth()`;
  refresh is one `SingleFlight` per server (`mcp/oauth/auth.ts`). Do not add a second refresh path: rotating refresh tokens
  break under concurrent refresh.
- Credentials and client registrations are AES-GCM encrypted with additional data binding them to server and
  purpose. Never log, return or persist them anywhere else.
- Owner-added servers (`mcp/servers/servers.ts`, ADR 0006) are public https endpoints only (`mcp/servers/endpoint.ts`); their card is
  a claim for the owner's eyes, never model input. Configured servers win on id and cannot be removed.
- Credentials and grants are bound to the endpoint they were made for (`mcp/oauth/endpoints.ts`). Re-pointing a server id
  drops them at the next start; never carry tokens across endpoints.
- Every outbound call checks resident authority and the specific tool grant first. A tool grant also covers its
  `ui://` resource; nothing else does. "Allow app" (`McpGrants.setApp`) writes exact grants for the tools that declare
  the App's resource, never a wildcard.
  Allow all and None use `McpGrants.setTools` through `PUT /api/mcp/grants/batch`: exact requested names, one discovery,
  one synchronous transaction for tools and resources, existing Ask first policies preserved when allowing. Revoking needs no network;
  missing offered names are reported, never granted (ADR 0076).
- A Topic's setup chooses the servers and tools its chats use (`setup/`, ADR 0040). `mcp_list` and `mcp_call`
  ask `Setups.scope(conversationId)` before the grant check; a setup only chooses and never grants, and a
  helper's exclusions are forgotten with a server's grants (`mcp/oauth/endpoints.ts`).
- A Persona that chooses `tools: native` (ADR 0102; absent is the gateway) gets its setup's tools natively in its fork
  as `<server>__<tool>` (ADR 0101, `pi/fork-tools.ts`): a frozen,
  cleaned set that only decides what is offered. Every native call goes through `callRemoteTool`
  (`pi/remote-call.ts`), `mcp_call`'s own body, so authority, scope, ask-first, grant and schema are checked again at
  each call; never give a native tool a path of its own.
- Annotations, descriptions, prompts and results from servers are untrusted data. They never grant permissions or
  become instructions.
- Keep results bounded and errors typed (`UpstreamMcp` with a reason). A refused refresh means `needs_auth`.
- A result's links, embedded resources and audio are kept in the owner's files by `materialize` (`mcp/content/materialize.ts`,
  ADR 0065), never as bytes in the conversation: a public https link is fetched with no credentials (`isPublicHttps`
  for it and every redirect; `http:` and private addresses are refused), a non-web scheme only through
  `resources/read` under the owner's resource grant, and a block that cannot be kept is a note, never a failed call.
  Record a result's content with `recordedContent` (links without query or fragment) wherever it reaches a transcript
  or an outcome.
- Inbound tokens must verify locally, name `/mcp` as audience, come from an enabled client with live consent and a live
  grant (ADR 0114); their scope claim (`goblin`) counts for nothing. Inbound OAuth follows the MCP authorization spec
  (ADR 0122, `auth/protocol.ts`): a client is its Client ID Metadata Document (dynamic registration stays until the
  known clients connect that way), redirect URIs are `localhost` or https (no `cursor://`), tokens are plain bearer with
  DPoP stripped, every authorization asks `offline_access`, the 401 names `goblin` alone and says `invalid_token` for a
  refused bearer. Never add a DPoP path without proof checks at `/mcp`. Every credential, installed app or client, has one grant:
  level × reach × extras × lifetime (`packages/contracts/src/grants.ts`, stored in `auth/grants.ts`, mirrored in the
  agent by `grants/service.ts`). The workspaces a client reaches are its grant's (ADR 0097), read with the person's
  memberships on every call, and an app's are its installations': a tool of a caller that reaches more than one takes a
  required `workspace` (`inbound/mcp-server.ts` `naming`), and a new tool needs nothing extra for it as long as its
  input is a Struct made by `standard`. An inbound client's messages go into main, labelled with its name. An installed
  app's go into the Topics it reaches, labelled `[from server <app name>]`; every Topic is sealed (ADR 0115), and what a turn may do is its senders' power
  (`grants/power.ts`): every tool has its need in `pi/tool-needs.ts` (`TOOL_NEEDS`), read by the filter, the call-time
  guard (`pi/power.ts`, deny by default) and the tool itself; never add a tool without giving it its need on purpose,
  and check what depends on a call's arguments (a connection, another Topic, a setup) in the tool.
- Every `EndpointAccess` endpoint has its tool in `inbound/tools.ts` but the streamed ones (`STREAMED`): a chat's stream
  (ADR 0110) is server-sent events a credential reads over HTTP with its own token on `/w/<slug>/api`, and the
  server's instructions say where. An app reads a chat's stream in full, so nothing a tool returns may carry a credential; the stream's frames
  redact goblin-shaped secrets as a backstop (`streams/redact.ts`), never the boundary.
- A send is AG-UI's `RunAgentInput` (ADR 0111): `conversation_send` and `thread_start` keep plain fields a model writes
  (`PlainSend`, `PlainThreadStart`) and build the body with the contracts' `runInput` and `threadStart`, so the tool
  and the HTTP request are one handler and one reading (`chats/run-input.ts`). Never give a tool its own copy of the
  body's rules.
- Events (`mcp/events/engine.ts`, ADRs 0011 and 0073) require resident authority and an exact server/name/canonical-arguments owner
  grant through the originating endpoint-bound connection. A server offers Events by top-level `capabilities.events`
  (decoded at the authenticated SDK fetch seam, which strips it) or by the `io.modelcontextprotocol/events` extension,
  which goblin declares too (ADR 0041). Signed controls have separate schemas; payloads never grant or become
  instructions. Each subscription generation adds an opaque random `goblin_generation` query value to the connection's
  authenticated hook path. The marker grants nothing; it keeps an old subscribe or unsubscribe from changing a replacement.
- goblin also publishes Events (`publish/`, ADR 0112, [published events](../../../docs/architecture/published-events.md)):
  one thin `conversation.updated` wake (`{ chat, topic, entry, activity, attention }`, never content), served as the
  owner API's `events` group and on `/mcp` (`inbound/events-methods.ts`, which declares `capabilities.events` and the
  extension to every credential). What a wake says is pure (`publish/payload.ts`), apart from the
  journal and fan-out that take it (`publish/journal.ts`); a credential's lease reaches only the chats of Topics its
  grant reaches, by the agent's mirror (`app_grant_reach`), with no request. Leases are verified by
  a signed challenge outside any transaction; deliveries are claimed, sent through `publishFetch` and settled under
  their claim, never inside a transaction. The account API ends a holder's leases (`/internal/publish/terminate`)
  before it uninstalls or narrows an installation, deletes an app or revokes a client; keep that ahead of any new way
  access ends.
- Sources (`sources/`, ADRs 0066, 0069) are how any server's events carry the owner's own messages: an owner-confirmed setup
  of JSON pointers and whole-value argument templates (`SourceSetup`), never a server's name. Confirmation grants the
  wake selector and the read and reply tools, subscribes `source:<id>` (handler `source-wake`) and binds the Source to
  the endpoint and its tools' grant versions; a change pauses it for review. Only messages the confirmed speaks-for-me
  rule matches become owner turns, with no more authority than the app's; everything else stays untrusted data.
  Replies are goblin's calls under the owner's grant (`caller: 'model'`), one operation id a piece. No server suggests a
  setup: only the agent's `source_propose` proposes one (ADR 0068). A `title` pointer names a conversation, `newKeys`
  may give each new one a Topic of its own (`topic-per-key`), a message's `attachments` (MCP content blocks) are kept
  with `materialize`, and an owner turn's content carries goblin's `ownTurn` mark after the words.
- Notify me via (`sources/notify.ts`, ADRs 0066, 0070) is the one way goblin's own notices leave: a routine's notice
  copies and the apps' `notify` power fill its whole-value template (`sendThroughSink`), as goblin's call under the
  owner's grant, with resident authority and the sink's revision checked again right before the call leaves. A file
  goes to a server as a `file_link` URL in a tool's arguments (MCP has no upload); the receiving tool's grant and Ask
  first decide whether it is sent.
  Result predicates in the owner's sink setting decide accepted, retryable or rejected outcomes (ADR 0071); absent,
  unmatched or conflicting predicates mean unknown and never authorize an automatic retry. Echo suppression matches
  an exact event name and canonical arguments on the connection, not the connection alone. Every save gets a fresh
  revision, including an identical save in the same second.
- The shelf (`mcp/servers/shelf.ts`, ADRs 0052, 0061) is data, one endpoint per entry on every deployment (`MCP_SHELF`
  replaces or adds entries): one mysi connection (`mysi.lol/mcp?codemode=off`) instead of the separate my* servers,
  publishing (Cloudflare), then servers that need no sign-in in groups; re-probe one with an `initialize` before
  adding it. mysi names
  tools `<service>_<tool>` and Events `<service>.<event>`; no code checks an app's tool or Event name (ADR 0063): a
  Source or a routine names exactly what its connection lists. `mcp_list` lists a connection with many such tools by
  service (`service`, `query`).
- Pinning an App adds no grant. Every owner write, `/api/mcp/` included, needs the app's Origin and the CSRF header at
  the Worker's edge (ADR 0038); the bridge remains bound to the originating server.
- The owner's MCP endpoints are the owner API's `mcp` and `resident` groups (`packages/contracts/src/api/mcp.ts` and
  `resident.ts`, handlers in `mcp/servers/api.ts` and `mcp/resident-api.ts`) over the services in `mcp/service.ts` (`McpServers`,
  `McpGrants`, `McpConnections`, `Approvals`, `Events`, `Resident`). An App's own calls carry `x-mcp-caller: app`,
  which the edge forwards and the contract reads, so they are held to the App's grants. The OAuth callback is the
  `mcp` group's raw `oauthCallback` (`GET /api/mcp/oauth/callback`; the edge sends a non-member of the state's
  workspace to `/connect-elsewhere` instead, ADR 0096), a redirect to Connections, with `ref` when it
  failed.
- Inbound `/mcp` is one server for every credential (ADRs 0086, 0114, 0120): an OAuth access token, a client's acting
  for a person or an installed app's (`inbound/route.ts`); any other bearer gets the sign-in challenge. Each tool in the registry (`inbound/tools.ts`, `mcp-server.ts`,
  `inspect-tools.ts`, `config-tools.ts`) calls one owner endpoint as the credential (`ownerCall` in
  `inbound/client.ts`, forwarding `x-goblin-caller`) and is listed only when the grant's level and extras hold the
  endpoint's `EndpointAccess` (`offers`); owner admission checks the same, a client's person's role too
  (`ROLE_POWER`), counts the grant per minute, syncs the mirror and never grants resident authority. Handlers check
  reach with `grants/policy.ts`. A refusal for want of access is `AccessInsufficient` with a `widenUrl`; `replyWith`
  offers it as URL elicitation to a client that declares it (`inbound/access.ts`). `access_read` answers the grant
  itself. A new tool is a new annotated endpoint first.
- Fixture tests (`test/mcp/`) prove protocol behaviour; the real behaviour of mysi and its apps (myplan, mytab and the
  rest) is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routine confirmation grants only the reviewed exact Event selector. Subscribe validates arguments against the installed producer descriptor schema. Routine consumers share leases, retire by revision and ACK only after run/pending/skip metadata is durable; gap/termination controls do not authorize a model turn.
- Connections (ADR 0041): one server may have several connections, each with the owner's label (`mcp/servers/labels.ts`,
  unique ignoring case; DCR `client_name` is plain "goblin", ADR 0062) and its own authenticated webhook path
  (`/hooks/mcp-events/<user>/<connection>/<token>`, with the generation query from ADR 0073). Model text names one as `"<label>" (<id>)` (`named`); labels and
  notice text never enter telemetry. A connection that sends events offers them (`ServerView.events`: open, dismissed,
  done; `mcp/events/offers.ts`); `mcp_list` shows its first 64 event streams as untrusted data when asked
  (`events: true`). goblin reads a descriptor's standard fields only (`name`, `title`, `description`, `inputSchema`,
  `payloadSchema`, `delivery`; ADR 0068), never its `_meta`: the title and description (`eventWords`) are claims for
  the owner's eyes, and nothing a server says picks, grants or confirms a selector. `mcp_list` lists a connection's tools in brief (name, one-line description, flags that differ) and
  gives input and output schemas only for the tools named in `tools`: its result stays in the model's context. A
  listing that names no tools carries the server's `instructions`, untrusted and cut to 2000 characters (ADR 0096). Its list of
  connections puts connected ones first, so a configured connection never signed in does not win.

- Per-call approvals (ADR 0028): only owner-selected `askFirst` policy pauses a granted tool. Prepare the encrypted
  frozen call in Pi's beforeTool hook and terminate with a local approval marker from execution. Owner approval
  dispatches identical arguments through the shared guard; bind endpoint, grant version, caller and execution ids.
  Claim dispatch intent once, refuse automatic retries, and mark interrupted intent uncertain on reconstruction.
  Routine, subagent and App paths cannot bypass the policy; remote hints never choose it. The outcome goes back to
  its chat as an input (`sendOutcome`); when nothing can pay for a turn it is kept there as a passive `app.mcp_outcome`
  entry instead, and the decision still answers 200: the call already ran, so the budget never loses its outcome.

- Protocol 2026-07-28 (ADR 0042). Tools are re-listed in place (`mcp/connections/tool-list.ts`: one flight per connection, never a
  partial list, stale on failure); a `subscriptions/listen` stream is held only while a connection is used (closed
  60 s after its last use, the next use lists first). Only the model's `mcp_call` declares URL elicitation, per
  request (`McpConnections.callModelTool`, `mcp/url-requests/url-asks.ts`), and so does the dispatch of its approved held call
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
  the persisted App entrypoint (`mcp/apps/entrypoints.ts`), Choose access's scope union and the data shelf cover every
  server; a tool that spends is controlled by Ask first. The skill learner writes drafts to the owner's files and calls
  no server's tool. External messaging uses Sources (ADR 0069). Never add a server-specific branch: give the owner a
  choice that works for any server.

- MCP Apps: goblin declares `io.modelcontextprotocol/ui` (`text/html;profile=mcp-app`) to every server. An App's HTML
  is read from a resource's `text` or base64 `blob` (decoded and bounded in `mcp/apps/app-html.ts`, strict UTF-8). A call
  held for approval, or a finished URL request, keeps its App when it completes (`mcp/apps/kept-app.ts`), and the App
  launches with the real result, not the transcript's placeholder.
