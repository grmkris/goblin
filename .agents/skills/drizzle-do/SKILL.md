---
name: drizzle-do
description: Change goblin application-owned Durable Object schemas, SQLite migrations, or Drizzle driver integration.
---

# Drizzle Do in goblin

ADR 0115's local/test dquickts spike adds `app_code_runs` and `app_code_calls` through a forward additive migration.
Heap snapshots remain trusted server-only data; integrity binds their build, source, run id and counters. The journal
records intent before dispatch and response before advancing the heap. Never hold a transaction across that host wait.

Drizzle owns only goblin application tables and migrations; Pi/vendor storage stays outside this schema.

- Verify the current Durable Object SQLite driver and runtime-safe migration entrypoints from installed source.
- Use `app_*` names for every application table. Protect the complete vendor ownership set even when a vendor table has another prefix.
- Never introspect/adopt/migrate vendor tables. Migration generation reads application schema only. Shell's Workspace
  tables (`cf_workspace_*`, the owner's files, ADR 0022) are vendor-owned too.
- Apply migrations before application code needs them; repeated initialization must be safe. Until launch goblin is
  greenfield (ADR 0041): edit a migration in place as if the schema had always been so, and reset dev
  (`destroy:dev`) in the release that ships it; never add compatibility code for old rows.
- Keep transactions short and synchronous to database work; never hold one across model/MCP/HTTP calls or waits.
- Prove application migrations and their reapplication leave vendor state intact using the actual supported runtime harness.

Before changing an API call, read the current [documentation](https://orm.drizzle.team/docs/connect-cloudflare-do) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Application storage has one fresh baseline in `storage/migrations/baseline.ts`, with live declarations in
  `storage/*.ts`; D1 auth has `apps/runtime/migrations/0000_baseline.sql`. Retired tables and columns are absent.
  Compare table/column parity and exercise FTS5 and uniqueness constraints when either schema changes. The native
  baseline canary verifies first application and reapplication against populated Pi/Agents storage.
