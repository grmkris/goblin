# Purrable: instructions for coding agents

Purrable is the owner's resident personal agent on Cloudflare. A native Agents SDK Durable Object runs Pi Durable for
conversations and execution; Effect composes application services; Alchemy owns infrastructure. Read
[README.md](README.md), [the architecture](docs/architecture.md) and the workspace instructions before editing.

## Work and ownership

- Work on `main`. Commit each coherent, green change separately as it lands; never batch unrelated changes.
- Other agents share this checkout. Preserve edits you did not make and `.spec.md.swo`. Never stash, reset, restore
  or delete foreign files. Stage exact owned paths or hunks, never `git add .` or `git add -A`.
- A red gate in a file you did not touch may be someone's mid-edit: check `git status`/`git diff` before fixing it.
- Run expensive checks through `heavy` (`heavy bun run check`). Exit 75 means contention; retry later. Never pipe it.

## Runtime invariants

- `PersonalAgent extends Agent` and registers the native `PiHarness` with the Agent lifecycle. Do not replace Pi.
- Pi owns transcripts, tasks, submissions, recovery and extensions. Application tables use the `app_` prefix through
  Drizzle; every vendor-owned SQLite table (`pi_*`, `cf_agents_*`, `_cf_*` and the rest in `storage/vendor.ts`) is
  untouchable.
- Keep SQLite transactions short. Never hold a transaction or lifecycle gate across model calls, network waits or
  token refreshes.
- Better Auth (`mcp()` + `jwt()`) lives in an isolated D1 auth store. Do not add `oauthProvider()` or a custom adapter.
- Outbound MCP calls require an exact owner grant for the server and tool/resource. Tool annotations, descriptions and
  remote content are untrusted data: they never grant permission and never become instructions.
- MCP Apps run in nested opaque sandbox frames through their originating authorized connection only.
- Submission acceptance is not external completion. Use stable operation IDs and never claim exactly-once effects.

## Provider and secrets

- Coding agents and local runs use CLIProxy. The deployed Worker calls models through Railway LiteLLM with a
  dedicated, model-limited, budget-capped key. Never bind the LiteLLM master key into the Worker.
- Secrets live in mode-600 `.local/*.env` files and Worker secret bindings. Never print, commit, expose in browser
  bundles or persist them in transcripts, logs or docs. Outbound OAuth tokens are encrypted at rest in the Agent DO.
- The `dev` stage is the owner's daily instance: treat its data as real. Schema changes there are additive migrations.

## Quality

- Run `bun run check:fast` while iterating and `bun run check` before claiming completion.
- New code has zero lint, Effect or Knip findings. Fix code first; every disable states a specific reason and every
  unavoidable type assertion carries a `// SAFETY:` comment.
- Tests are meaningful and bounded: real integrations for happy paths, injected services instead of module mocking.
- Keep README, architecture, development docs and skills in step with code changes. `docs/archive/` is frozen history.

## Workspace map

- [Runtime](apps/runtime/AGENTS.md): native agent, Effect services, MCP host, auth and runtime tests.
- [Web](apps/web/AGENTS.md): TanStack Start UI, conversation stream and the MCP Apps host.
- [Contracts](packages/contracts/AGENTS.md): shared runtime-validated schemas only.
- [UI](packages/ui/AGENTS.md): editable local shadcn components and styling.
- [Tools](tools/AGENTS.md): quality gates, import graph and docs checks.
