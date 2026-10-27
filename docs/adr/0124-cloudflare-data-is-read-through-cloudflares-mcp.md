# ADR 0124: Cloudflare's own data is read through Cloudflare's MCP, not the goblin CLI

Status: Accepted 2026-10-27 (owner: "drop this because we have Cloudflare MCP and we can access everything through that
MCP already"). Amends ADR 0037 (how its flow points and failure references are read). No runtime change.

## Context

Three `goblin` CLI commands read Cloudflare's APIs directly, beside its `/mcp` commands: `goblin logs <id>` (Workers
Observability events of the stage's Worker that mention an id), `goblin lookup <ref|request|op>` (those lines, then
`inspect_details` of the operation they name) and `goblin stats` (ADR 0037's flow totals, by Analytics Engine SQL).
Each needed the operator's own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell, a second credential
beside the CLI's OAuth sign-in. Cloudflare's own MCP server, in the repository's `.mcp.json` beside goblin's, runs any
Cloudflare API call under the person's own Cloudflare sign-in and account role, the same two queries included (checked
2026-10-27 against goblin-prod: its telemetry events query and an Analytics Engine `SQL` over `goblin-prod-flows`).

## Decision

**The CLI reads goblin only.** `goblin logs`, `goblin lookup` and `goblin stats` go, with the Cloudflare credentials
they read. The CLI keeps its `/mcp` commands (inspection, `follow`, `token`), all on its own OAuth sign-in.

**Cloudflare's data is read through Cloudflare's MCP**, with the reader's own Cloudflare access:
- a failure reference (`… · ref 7f3a9c12`), a request id or an operation id: the stage Worker's Workers Observability
  events (`POST /accounts/:account/workers/observability/telemetry/query`, `view: events`, filtered on
  `$metadata.service` = `goblin-dev` or `goblin-prod`, the id as its needle), then `inspect_details` of the operation
  a line names, on goblin's `/mcp`;
- flow totals: Analytics Engine SQL (`POST /accounts/:account/analytics_engine/sql`) over the stage's `<worker>-flows`
  dataset, with ADR 0037's columns: `blob1` the flow, `blob5` the outcome, `index1` the hashed agent, `double3` the
  duration, weighted by `_sample_interval`.

What ADR 0037 records, and how, is unchanged; only who reads it, and with what, changes.

## Consequences

- One credential per system: goblin through its `/mcp` sign-in, Cloudflare through Cloudflare's. A Cloudflare
  account member with read access debugs goblin without a token of their own.
- Release smoke's own Analytics Engine read (`scripts/smoke-release.ts`) is CI's, with CI's credentials, and stays.

## Rejected

- **Keeping the commands as thin shortcuts.** They duplicate what Cloudflare's MCP does with a credential the CLI
  should not hold, and their tests covered only query shapes Cloudflare already documents.
