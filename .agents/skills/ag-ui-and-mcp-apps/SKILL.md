---
name: ag-ui-and-mcp-apps
description: Change Purrable AG-UI projection, snapshot reconnect, sandboxed MCP Apps iframe host, bridge permissions, or rich-result fallback.
---

# Ag Ui And Mcp Apps in Purrable

AG-UI projects Pi committed state/events to the browser. MCP Apps are separate tool-associated surfaces from the originating server.

- Pi state remains authoritative; do not persist a second transcript or invent cursor replay.
- Reconnect loads a fresh Pi snapshot and live stream, disposes the previous stream, and represents committed events without duplication claims unsupported by APIs.
- Render negotiated tool-associated ui:// resources inside the Apps sandbox/CSP. Validate message origin and source.
- App tool/resource calls go only through the parent authorized connection to the originating server and its specific grants.
- Credentials never enter iframe state, browser bundles, model context, logs, or transcripts. No arbitrary cross-server access.
- Preserve app-only tool visibility and ordinary tool-result fallback. Host methods remain unsupported until implemented.
- Test a real render/permitted interaction path separately from transport/unit tests; AG-UI is not an Apps protocol.

Read the current [official documentation](https://apps.extensions.modelcontextprotocol.io/), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
