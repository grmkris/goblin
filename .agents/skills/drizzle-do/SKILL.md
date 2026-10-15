---
name: drizzle-do
description: Change goblin application-owned Durable Object schemas, SQLite migrations, or Drizzle driver integration.
---

# Drizzle Do in goblin

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

- A removed feature's tables stay in the migrations, unread, until they are squashed: `app_home`,
  `app_home_operations`, `app_decision_proposals` and `app_decision_labels` (ADR 0067) have no Drizzle schema left.
