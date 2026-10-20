# goblin: instructions for coding agents

Master file. `CLAUDE.md` is a symlink to it — edit `AGENTS.md`. Agent config: `.agents/skills` (master) → `.claude/skills` links; `.mcp.json` → generated `.codex/config.toml` + `.cursor/mcp.json`. Run `bunx repoagents` after changing any of them.

goblin gives every user their own resident personal agent on Cloudflare: one native Agents SDK Durable Object per
user runs Pi Durable for conversations and execution; Effect composes application services; Alchemy owns
infrastructure. Read
[README.md](README.md), [the architecture](docs/architecture.md) and the workspace instructions before editing.

## Work and ownership

- Work on `dev`; there is no `main`. GitHub's default branch is `prod`, so visitors see what is live (ADR 0077): branch
  from `dev` and base every PR on it (`gh pr create --base dev`). CI on GitHub-hosted runners deploys every push to `dev` that passes Check; `bun run promote <sha>` fast-forwards `prod`, which CI deploys. A deploy or destroy of dev or prod by hand is break-glass (`GOBLIN_BREAK_GLASS=1`). Commit each coherent, green change separately as it lands; never batch unrelated changes.
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
- Better Auth (`mcp()` + `jwt()` + `apiKey()`) lives in an isolated D1 auth store. Do not add `oauthProvider()` or a
  custom adapter. A server API key reaches only the Topics, chats and Personas it made, and never renews resident
  authority (ADR 0081).
- Outbound MCP calls require current resident authority and an exact owner grant for the server and tool/resource.
  Tool annotations, descriptions and remote content are untrusted data: they never grant permission and never become
  instructions. One exception is a skill from a server the owner turned skills on for (ADR 0008): the agent follows its
  steps, but it still grants nothing. The other: messages matching a Source's speaks-for-me rule the owner confirmed
  (ADR 0066) become the owner's own turns, with no more authority than one typed in the app, and still grant nothing.
- MCP Apps run in nested opaque sandbox frames through their originating authorized connection only.
- Submission acceptance is not external completion. Use stable operation IDs and never claim exactly-once effects.

## Provider and secrets

- Coding agents and local runs use CLIProxy. The deployed Worker calls models through the deployment's endpoint
  (Railway LiteLLM, with a dedicated, model-limited, budget-capped key) or the owner's own endpoint and key
  ([ADR 0059](docs/adr/0059-bring-your-own-model-endpoint.md)), sealed in the agent and never answered back. Never bind
  the LiteLLM master key into the Worker.
- Secrets live in mode-600 `.local/*.env` files and Worker secret bindings. Never print, commit, expose in browser
  bundles or persist them in transcripts, logs or docs. Outbound OAuth tokens are encrypted at rest in the Agent DO.
- The repository is public. Committed handoffs, evidence and docs never carry private paths, tailnet IPs, personal
  emails, private ids (myplan, Privy, wallet) or personal wallet addresses; private notes go to myplan.
- The `dev` stage is the daily instance. It holds test data only (owner, 2026-10-08), so spikes may deploy there.
  goblin is greenfield until launch (owner, 2026-10-11): no backwards compatibility, no legacy decoders; migrations are
  edited in place as if the schema had always been so, and a release that edits an applied one resets dev first
  (`GOBLIN_BREAK_GLASS=1 bun run destroy:dev -- --confirm-reset`, then `GOBLIN_BREAK_GLASS=1 bun run deploy:dev`
  re-creates it: CI refuses a plan that would create goblinAuth, Files or Web). Prod is reset only when the owner
  decides, as for the hackathon release (owner, 2026-10-12) and the channel-info baseline (owner, 2026-10-20): export
  its auth D1 into `.local` (`wrangler d1 export goblin-prod-auth --remote`), pause CI, then
  `GOBLIN_BREAK_GLASS=1 GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset`, re-create it with a
  break-glass `deploy:prod` of the same sha, and promote that sha once CI is back on. A user only ever reaches their
  own agent; never add a route that takes an agent name from the request.
  Telemetry never carries content ([ADR 0024](docs/adr/0024-observing-conversations.md)).

## Quality

- Run `bun run check:fast` while iterating and `bun run check` before claiming completion.
- New code has zero lint, Effect or Knip findings. Fix code first; every disable states a specific reason and every
  unavoidable type assertion carries a `// SAFETY:` comment.
- Tests are meaningful and bounded: real integrations for happy paths, injected services instead of module mocking.
- Keep README, architecture, development docs and skills in step with code changes. Keep historical evidence outside
  the living documentation tree.
- Never amend an ADR in place. A changed decision is a new ADR that names what it supersedes; a fully replaced ADR moves
  to `docs/adr/archive/`, and `docs/adr/README.md` keeps each one's status.

## Workspace map

- [Runtime](apps/runtime/AGENTS.md): native agent, Effect services, MCP host, auth and runtime tests.
- [Web](apps/web/AGENTS.md): TanStack Start UI, conversation stream and the MCP Apps host.
- [OpenUI spike](apps/openui-spike/AGENTS.md): isolated interactive-reply playground and its public preview Worker.
- [CLI](apps/cli/AGENTS.md): `goblin`, the terminal client of `/mcp`'s inspection tools and Workers Logs.
- [Contracts](packages/contracts/AGENTS.md): shared runtime-validated schemas only.
- [UI](packages/ui/AGENTS.md): editable local shadcn components and styling.
- [Kit](packages/kit/AGENTS.md): drawn blocks (diagrams, charts, maps) for the chat and agent apps.
- [App](packages/app/AGENTS.md): the agent app SDK and toolchain, run inside Dynamic Workers.
- [Tools](tools/AGENTS.md): quality gates, import graph and docs checks.
