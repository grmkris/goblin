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
- Credentials and grants are bound to the endpoint they were made for (`mcp/endpoints.ts`). Re-pointing a server id
  drops them at the next start; never carry tokens across endpoints.
- Every outbound call checks resident authority and the specific tool grant first. A tool grant also covers its
  `ui://` resource; nothing else does. "Allow app" (`setAppGrant`) writes exact grants for the tools that declare
  the App's resource, never a wildcard.
- Annotations, descriptions, prompts and results from servers are untrusted data. They never grant permissions or
  become instructions.
- Keep results bounded and errors typed (`UpstreamMcp` with a reason). A refused refresh means `needs_auth`.
- Inbound tokens must verify locally, name `/mcp` as audience, come from an enabled client with live owner consent.
  Each inbound client sees only its own session.
- Fixture tests (`test/mcp/`) prove protocol behaviour; real MyPlan/MyBrowser behaviour is proven only on dev.

Before changing an API call, read the current [documentation](https://modelcontextprotocol.io/specification/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
