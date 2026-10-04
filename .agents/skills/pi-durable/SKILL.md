---
name: pi-durable
description: Change Purrable Pi Durable and PiHarness integration, persistence, submission, event projection, or reconstruction tests. Use for harness lifecycle work.
---

# Pi Durable in Purrable

Pi Durable is the source of truth for transcript/task/inbox/steering/recovery state. Use the pinned public harness adapter; do not recreate these systems.

- Verify `agents/harness/pi`, the Pi Durable factory receiving storage/context, and `lifecycle.use` against installed declarations before edits.
- Durable submission receipts and stable operation IDs are acceptance, not completed external work. Never claim exactly-once remote effects.
- Session events are an authoritative snapshot plus committed live batches with no cursor replay. Reconnect creates a fresh stream and disposes the previous one.
- Register trusted extensions through Pi's public registry. Application grants run before capability execution; replay-safe means harmless replay or reconciliation through a stable operation ID.
- Separate harness initialization, supported persisted state, reconstruction, and deployed eviction evidence. Vendor tables are the complete verified ownership set, never inferred from a prefix.
- Record cancellation waiting on uncooperative tools, model/alarm limits, and deletion limitations as compatibility gaps.

Read the current [official documentation](https://developers.cloudflare.com/agents/harnesses/pi/), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
