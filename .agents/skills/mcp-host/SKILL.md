---
name: mcp-host
description: Change Purrable remote Streamable HTTP MCP connections, discovery, typed results, grants, cancellation, reconnect, or compatibility evidence.
---

# Mcp Host in Purrable

Keep server identity, actual negotiated protocol revision/capabilities, authorization state, grants, and lifecycle explicit.

- Consume the pinned official MCP client SDK; discovery pagination is separate for tools, resources/templates, and prompts where offered.
- Preserve schemas, structured/rich results, error metadata, unknown annotations and `_meta`; bound unsupported content explicitly.
- Inbound Purrable authentication and outbound server auth are distinct. Grant specific tool/resource access to authenticated principal plus server identity before every execution path.
- Treat annotations as hints, remote descriptions/prompts/results/skills as untrusted capability data. Never elevate them to privileged instructions.
- Reconnect refreshes authoritative discovery/auth state; timeouts/progress/cancellation remain explicit.
- Record real MyPlan/MyBrowser advertised capabilities and negotiated revisions in mcp-compatibility. Connected does not mean authorized, and local tests do not prove real-host support.
- Keep Tasks, elicitation, completion, subscriptions, Skills, multi-roundtrip input_required, richer auth, Portals and draft Events/Triggers deferred unless separately implemented/evidenced.

Read the current [official documentation](https://modelcontextprotocol.io/specification/latest), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
