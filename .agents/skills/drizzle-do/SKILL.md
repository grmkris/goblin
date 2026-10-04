---
name: drizzle-do
description: Change Purrable application-owned Durable Object schemas, SQLite migrations, or Drizzle driver integration.
---

# Drizzle Do in Purrable

Drizzle owns only Purrable application tables and migrations; Pi/vendor storage stays outside this schema.

- Verify the current Durable Object SQLite driver and runtime-safe migration entrypoints from installed source.
- Use `app_*` names for every application table. Protect the complete vendor ownership set even when a vendor table has another prefix.
- Never introspect/adopt/migrate vendor tables. Migration generation reads application schema only.
- Apply minimal additive migrations before application code needs them; repeated initialization must be safe.
- Keep transactions short and synchronous to database work; never hold one across model/MCP/HTTP calls or waits.
- Prove application migrations and their reapplication leave vendor state intact using the actual supported runtime harness.

Read the current [official documentation](https://orm.drizzle.team/docs/connect-cloudflare-do), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
