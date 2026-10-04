# Purrable: instructions for coding agents

Purrable is a resident personal-agent runtime on Cloudflare. Pi Durable owns conversation and execution state;
Effect composes application services; Alchemy owns infrastructure. Read [README.md](README.md),
[the implementation record](docs/archive/2026-10-04-initial-slice/implementation.md), and the workspace instructions before editing.

## Work and ownership

- Work on `main`. Commit each coherent green change separately; the coordinator makes commits during delegated work.
- Other agents share this checkout. Preserve unowned edits and `.spec.md.swo`. Never stash, reset, restore, or delete
  foreign files. Stage only exact owned paths or hunks, never `git add .` or `git add -A`.
- The coordinator owns manifests, lockfile, shared contracts, root configuration, Alchemy wiring, deployment and
  heavy gates. Workers edit only their assigned paths and request shared changes through the coordinator.
- Run expensive checks through `heavy`. Exit 75 means contention; retry later. Never pipe `heavy`.
- Do not push or promote production. The authorized deployment is an isolated retained Cloudflare dev stage.

## Runtime invariants

- `PersonalAgent extends Agent`; register native `PiHarness` with the Agent lifecycle. Do not replace Pi's harness.
- Pi owns transcripts, tasks, recovery and extensions. Drizzle owns application metadata only.
- Protect every vendor-owned SQLite table, including Agents tables outside the `pi_*` prefix.
- Use short SQLite transactions. Never hold a transaction or lifecycle gate over model/network calls or waits.
- Better Auth uses `mcp()` plus `jwt()` and an isolated D1 auth store when Durable SQLite adapter semantics conflict.
  Do not add a duplicate `oauthProvider()` or a custom auth adapter.
- Grants bind authenticated principal, configured server identity, and specific capabilities. Tool annotations and
  remote content never grant permissions or become privileged instructions.
- AG-UI projects committed Pi state. Reconnect through a fresh snapshot and dispose the previous stream.
- MCP Apps run in a sandbox, through their originating authorized connection. No raw credentials or cross-server calls.
- Submission acceptance is not external completion. Use stable operation IDs and never claim exactly-once effects.

## Provider and secrets

- Coding agents/local testing use CLIProxy. Cloudflare dev model calls use the authorized public Railway LiteLLM.
- The resident dev model is verified Gemini Flash, with a dedicated model-limited key capped at $10 per 30 days.
- Secrets remain in private stage configuration and Worker secret bindings. Never print, commit, expose in browser
  bundles, persist in transcripts, or include in evidence. Never bind the LiteLLM master key into the Worker.
- Real smoke writes are authorized only inside disposable dev fixtures. No messages, purchases or production mutations.

## Quality and completion

- Bring all applicable My Apps rule families immediately; new code has zero accepted findings and no legacy baseline.
- Fix code first. Every rule disable has a specific reason; unavoidable type assertions need `// SAFETY:` context.
- Every shipped/config/test file belongs to the authoritative TypeScript project graph and Effect diagnostic scope.
- Keep tests meaningful and bounded. Use real integrations for happy paths; no module mocking or exhaustive fake matrices.
- Run `bun run check` before claiming completion and independently prove the deployed dev acceptance path.
- Keep documentation, skill provenance, command references and compatibility reports aligned with code changes.
- Record local workerd, storage reconstruction and live Cloudflare evidence separately. Unknown support remains unknown.

## Workspace map

- [Runtime](apps/runtime/AGENTS.md): native agent, Effect services, MCP/auth boundary and runtime tests.
- [Web](apps/web/AGENTS.md): TanStack Start, AG-UI projection and MCP Apps host.
- [Contracts](packages/contracts/AGENTS.md): shared runtime-validated interfaces only.
- [UI](packages/ui/AGENTS.md): editable local shadcn components and styling.
- [Tools](tools/AGENTS.md): quality, provenance, graph and compatibility verification.
