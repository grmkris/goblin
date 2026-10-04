---
name: pi-stream-and-mcp-apps
description: Change how the browser follows the Pi conversation (SSE snapshot, batches, reconnect) or the sandboxed MCP Apps host.
---

# Conversation stream and MCP Apps in Purrable

The browser follows committed Pi state over Server-Sent Events: `/api/agent/events` sends a snapshot of entries,
then batches, with a heartbeat. `apps/web/src/lib/projection.ts` turns entries into messages and tool calls.
`lib/parts.ts` folds them into render parts: each tool result joins the call that asked for it, with a lifecycle
state. `components/parts/registry.tsx` picks the renderer for each part.

- Pi state is authoritative. Do not keep a second transcript or invent cursor replay.
- Reconnect by opening a fresh stream and starting from its snapshot; dispose the previous stream. Back off between
  attempts (`conversation-stream.ts`).
- MCP Apps are tool-associated `ui://` resources from the originating server. Render them in the sandboxed iframe
  with its CSP; validate message origin and source.
- One live App per chat view (`components/apps`). Its iframe stays in the fixed stage, which follows the slot its
  display mode names; moving an iframe in the DOM reloads the App and loses its state. Positions come from the pure
  `lib/app-stage.ts` and `lib/spring.ts`, which are unit-tested; the stage writes them straight to the DOM each frame.
- An App's tool and resource calls go through the owner API to the originating server only, and need that server's
  grant. No cross-server calls, no credentials in iframe state, browser bundles, logs or transcripts.
- Keep the plain tool-result fallback for hosts or results without an App. Unimplemented host methods stay
  unsupported.
- A real browser render and a permitted App interaction are separate evidence from unit tests.

Before changing an API call, read the current [documentation](https://apps.extensions.modelcontextprotocol.io/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
