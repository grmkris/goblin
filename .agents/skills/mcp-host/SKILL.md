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
- The Telegram channel (`channel/`, ADR 0009) is an outbound connection like any other: the owner's "Use for
  Telegram" writes its four exact grants, and its pulls and replies check resident authority. Its doorbell route
  checks the hook token before an agent wakes and myagent's signature inside it; a doorbell never carries content.
- Fixture tests (`test/mcp/`) prove protocol behaviour; real MyPlan/MyBrowser behaviour is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
