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
- Telegram (`channel/`, ADR 0009) selects Events when advertised, otherwise the legacy doorbell. Preserve sanitized
  `telegram-tg-<update>` and reply operation ids; fence old cursor writes only after both leases confirm. Hooks persist
  receipts before asynchronous dispatch; accepted submissions are distinct from external delivery.
- MyInbox suggestions use dev.myinbox.lol locally and myinbox.lol on dev/test/prod. Discovery advertises DCR and PKCE public clients; owner sign-in/power approval and real-message acceptance are separate. MyGram local/dev stays dev.mygram.lol pending the owner's bot/account decision.
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
  unique ignoring case; DCR `client_name` is "goblin · <label>") and its own webhook URL
  (`/hooks/mcp-events/<user>/<connection>/<token>`). Model text names one as `"<label>" (<id>)` (`named`); labels and
  notice text never enter telemetry. A connection that sends events offers them (`ServerView.events`: open, dismissed,
  done; `mcp/events/offers.ts`); `mcp_list` shows its first 64 event streams as untrusted data.

- Per-call approvals (ADR 0028): only owner-selected `askFirst` policy pauses a granted tool. Prepare the encrypted
  frozen call in Pi's beforeTool hook and terminate with a local approval marker from execution. Owner approval
  dispatches identical arguments through the shared guard; bind endpoint, grant version, caller and execution ids.
  Claim dispatch intent once, refuse automatic retries, and mark interrupted intent uncertain on reconstruction.
  Routine, subagent and App paths cannot bypass the policy; remote hints never choose it.
