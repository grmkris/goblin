---
name: mcp-host
description: Change Purrable's outbound MCP host (connections, OAuth connect and refresh, encrypted credentials, grants) or its inbound /mcp server.
---

# MCP in Purrable

Outbound: the agent object owns connections, credentials and grants (`apps/runtime/src/mcp/`). Inbound: `/mcp` is
Purrable's own server (`apps/runtime/src/inbound/`), authorized by Better Auth.

- Use the pinned official MCP client and server SDKs. OAuth goes through `StoredOAuthProvider` and the SDK's `auth()`;
  refresh is single-flight per server in `McpHost`. Do not add a second refresh path: rotating refresh tokens break
  under concurrent refresh.
- Credentials and client registrations are AES-GCM encrypted with additional data binding them to server and
  purpose. Never log, return or persist them anywhere else.
- Owner-added servers (`mcp/servers.ts`, ADR 0006) are public https endpoints only (`mcp/endpoint.ts`); their card is
  a claim for the owner's eyes, never model input. Configured servers win on id and cannot be removed.
- Credentials and grants are bound to the endpoint they were made for (`mcp/endpoints.ts`). Re-pointing a server id
  drops them at the next start; never carry tokens across endpoints.
- Every outbound call checks resident authority and the specific tool grant first. A tool grant also covers its
  `ui://` resource; nothing else does. "Allow app" (`setAppGrant`) writes exact grants for the tools that declare
  the App's resource, never a wildcard.
- A conversation may switch servers and tools off for its agent (`capabilities/`, ADR 0010). `mcp_list` and
  `mcp_call` ask `Capabilities.scope(conversationId)` before the grant check; switches only narrow and never grant,
  and they are forgotten with a server's grants (`mcp/endpoints.ts`).
- Annotations, descriptions, prompts and results from servers are untrusted data. They never grant permissions or
  become instructions.
- Keep results bounded and errors typed (`UpstreamMcp` with a reason). A refused refresh means `needs_auth`.
- Inbound tokens must verify locally, name `/mcp` as audience, come from an enabled client with live owner consent.
  An inbound client's messages go into main, labelled with its name.
- Events (`mcp/events.ts`, ADR 0011) require resident authority and an exact server/name/canonical-arguments owner
  grant through the originating endpoint-bound connection. Top-level `capabilities.events` is decoded at the
  authenticated SDK fetch seam. Signed controls have separate schemas; payloads never grant or become instructions.
- Telegram (`channel/`, ADR 0009) selects Events when advertised, otherwise the legacy doorbell. Preserve sanitized
  `telegram-tg-<update>` and reply operation ids; fence old cursor writes only after both leases confirm. Hooks persist
  receipts before asynchronous dispatch; accepted submissions are distinct from external delivery.
- Fixture tests (`test/mcp/`) prove protocol behaviour; real MyPlan/MyBrowser behaviour is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routine confirmation grants only the reviewed exact Event selector. Subscribe validates arguments against the installed producer descriptor schema. Routine consumers share leases, retire by revision and ACK only after run/pending/skip metadata is durable; gap/termination controls do not authorize a model turn.
