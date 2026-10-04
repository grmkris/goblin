---
name: tanstack-start
description: Change Purrable TanStack Start routes, server/client boundaries, shared shadcn UI, Vite integration, or browser build behavior.
---

# Tanstack Start in Purrable

The web app is a thin browser projection over the resident runtime. TanStack Start owns routing and build integration.

- Verify pinned Start/Router/Vite APIs in installed declarations and current docs; no parallel custom React Router application.
- Keep browser zones free of runtime internals, Worker bindings, Bun and Node imports. Server/tooling exceptions must be explicit in the workspace graph.
- Cross-runtime contracts come from packages/contracts; UI primitives come from packages/ui. Do not add hypothetical reuse packages.
- Generated shadcn components remain editable and locally owned; follow monorepo aliases/components.json and token conventions.
- Support text/tool/progress display, submit/follow-up, stop, snapshot reconnect, and a sandboxed App surface without another agent state machine.
- Validate the built artifact and real browser behavior. Local route rendering is not Cloudflare deployment proof.

Read the current [official documentation](https://tanstack.com/start/latest), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
