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
- Desktop conversation layout uses Trellis 0.3.0 only after hydration, with nonclosable main and stable React portal hosts.
  Persist bounded versioned layouts per owner/device; prune stale panes and retain narrow-screen sheets. Reset keeps current panes.
- Validate the built artifact and real browser behavior. Local route rendering is not Cloudflare deployment proof.

Before changing an API call, read the current [documentation](https://tanstack.com/start/latest) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Account workspace state is an auth-D1 projection. Selection reloads Settings to close streams/Apps/caches and
  focus rechecks the session context. Phase A member/viewer Agent views stay closed. Invitation fragments are cleared
  before exchange; OTP sign-in and own-plan activation precede joining. Keep permission checkboxes empty by default.
