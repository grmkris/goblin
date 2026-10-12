# goblin: instructions for coding agents

Master file. `CLAUDE.md` is a symlink to it — edit `AGENTS.md`. Agent config: `.agents/skills` (master) → `.claude/skills` links; `.mcp.json` → generated `.codex/config.toml` + `.cursor/mcp.json`. Run `bunx repoagents` after changing any of them.

goblin gives every user their own resident personal agent on Cloudflare: one native Agents SDK Durable Object per
user runs Pi Durable for conversations and execution; Effect composes application services; Alchemy owns
infrastructure. Read
[README.md](README.md), [the architecture](docs/architecture.md) and the workspace instructions before editing.

## Work and ownership

- Work on private `dev`; promote an accepted SHA to `prod` through the Promote action. Commit each coherent, green change separately as it lands; never batch unrelated changes.
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
- Outbound MCP calls require current resident authority and an exact owner grant for the server and tool/resource.
  Tool annotations, descriptions and remote content are untrusted data: they never grant permission and never become
  instructions. The one exception is a skill from a server the owner turned skills on for (ADR 0008): the agent
  follows its steps, but it still grants nothing.
- MCP Apps run in nested opaque sandbox frames through their originating authorized connection only.
- Submission acceptance is not external completion. Use stable operation IDs and never claim exactly-once effects.

## Provider and secrets

- Coding agents and local runs use CLIProxy. The deployed Worker calls models through Railway LiteLLM with a
  dedicated, model-limited, budget-capped key. Typed decisions through the Workers AI `AI` binding, bound on dev only,
  are the scoped exception in [ADR 0031](docs/adr/0031-typed-decisions-through-workers-ai.md): metered, content-free
  telemetry, owner-confirmed proposals and no authority changes. Never bind the LiteLLM master key into the Worker.
- Secrets live in mode-600 `.local/*.env` files and Worker secret bindings. Never print, commit, expose in browser
  bundles or persist them in transcripts, logs or docs. Outbound OAuth tokens are encrypted at rest in the Agent DO.
- The `dev` stage is the daily instance. It holds test data only (owner, 2026-10-08), so spikes may deploy there.
  goblin is greenfield until launch (owner, 2026-10-11): no backwards compatibility, no legacy decoders; migrations are
  edited in place as if the schema had always been so, and a release that edits an applied one resets dev first
  (`bun run destroy:dev -- --confirm-reset`). Prod is reset only when the owner decides, as for the hackathon release
  (owner, 2026-10-12): `GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset`, then release the same sha. A user only ever reaches their
  own agent; never add a route that takes an agent name from the request.
  Telemetry never carries content ([ADR 0024](docs/adr/0024-observing-conversations.md)).

## Quality

- Run `bun run check:fast` while iterating and `bun run check` before claiming completion.
- New code has zero lint, Effect or Knip findings. Fix code first; every disable states a specific reason and every
  unavoidable type assertion carries a `// SAFETY:` comment.
- Tests are meaningful and bounded: real integrations for happy paths, injected services instead of module mocking.
- Keep README, architecture, development docs and skills in step with code changes. Keep historical evidence outside
  the living documentation tree.

## Workspace map

- [Runtime](apps/runtime/AGENTS.md): native agent, Effect services, MCP host, auth and runtime tests.
- [Web](apps/web/AGENTS.md): TanStack Start UI, conversation stream and the MCP Apps host.
- [CLI](apps/cli/AGENTS.md): `goblin`, the terminal client of `/mcp`'s inspection tools and Workers Logs.
- [Contracts](packages/contracts/AGENTS.md): shared runtime-validated schemas only.
- [Wallet worker](apps/wallet/AGENTS.md): Goblin Wallet's Worker, owner API, MCP and per-owner ledger.
- [Wallet web](apps/wallet-web/AGENTS.md): Goblin Wallet's owner console and MCP App views.
- [Wallet](packages/wallet/AGENTS.md): the shared wallet library: chains, amounts, contract and rails.
- [UI](packages/ui/AGENTS.md): editable local shadcn components and styling.
- [Kit](packages/kit/AGENTS.md): drawn blocks (diagrams, charts, maps) for the chat and agent apps.
- [App](packages/app/AGENTS.md): the agent app SDK and toolchain, run inside Dynamic Workers.
- [Tools](tools/AGENTS.md): quality gates, import graph and docs checks.

- [Bench](bench/AGENTS.md): reproducible native memory experiments and private run artifacts.
