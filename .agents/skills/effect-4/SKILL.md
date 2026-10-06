---
name: effect-4
description: Write or review Effect 4 services, layers, schemas, errors, and diagnostics in goblin. Use before changing runtime composition or Effect code.
---

# Effect 4 in goblin

Use the installed Effect 4 guide and declarations as the API authority. Verify the pinned version and imports before relying on memory.

- Use Context services, Layers, typed tagged errors, Schema at external boundaries, and scoped resource lifetimes.
- Keep pure transformations as ordinary functions; wrap platform I/O, retries, timeout, concurrency, and observability in Effect.
- Match errors with `catchTag` or `Match`; do not hand-compare `_tag` values or throw global `Error` from Effect failures.
- Use Effect platform services for HTTP, clock/date, random, crypto, logging, timers, and configuration. `process.env` is configuration input only where a documented tooling exception allows it.
- Do not hold a Durable Object transaction, lifecycle gate, or lock across network/model calls, timers, or waits.
- Keep Pi Durable state and vendor tables outside application Effect services; application services own only goblin contracts and `app_*` data.
- Run `bun run check:files <owned paths>` after edits. Run the root Effect diagnostics gate before handoff.

This skill proves source-level conventions only; it does not prove Cloudflare lifecycle behavior or provider reachability. Read the current official Effect 4 docs and installed `node_modules/effect/AGENTS.md` when APIs are uncertain.

Adapted from `grmkris/myapps@54259fdd5a2560d2595167d7ff0650826a039102`, `.agents/skills/effect-in-myapps/SKILL.md`,
reviewed 2026-10-04. goblin replaces app-specific MCP/storage paths and adds its native Pi/Drizzle ownership
boundaries. Source hash, internal-reuse authorization and adaptation details are recorded in `sources.json`.
