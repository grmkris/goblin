---
name: alchemy
description: Change Purrable infrastructure, Cloudflare bindings, local development, or isolated dev deployment through Alchemy.
---

# Alchemy in Purrable

Alchemy is the sole infrastructure source of truth. Read stack-compatibility before changing the pinned beta integration.

- Bind the native Agent class directly; do not force PiHarness through an Effect-native DO superclass.
- Keep deployment code out of Worker/runtime imports and runtime migration SQL.
- Preserve stage-derived physical resource names and explicit dev ownership. No production promotion or destructive cleanup is authorized by this skill.
- Put secrets in runtime bindings; never browser bundles, logs, transcripts, or iframe state.
- Verify current TanStack Start/Vite integration compatibility before adding any Cloudflare Vite plugin; do not maintain two deployment systems.
- Record plan/build evidence, real dev deployment receipts, and smoke results separately. A local artifact is not deployed acceptance.

Read the current [official documentation](https://alchemy.run/), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
