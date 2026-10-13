# Debuggability, Effect-native runtime and the typed owner API: 2026-10-10

The plan, approved by the owner on 2026-10-09, is the owner's private plan file. A conductor session ran it in parallel
lanes, all Claude subagents:

- three foundation lanes;
- twelve area lanes, in three waves;
- three integration lanes: lint, runtime and docs.

Lane briefs, status logs and gate logs were kept in a scratch directory on the dev box that is temporary and not kept.

## What is live

- **prod** (`goblin.surf`) and **dev** (`dev.goblin.surf`) both run `4c8c485`.
  - Both releases passed: dev with authenticated smoke, prod with public smoke, and drift verified on each.
  - Dev UI acceptance passed (0 errors, 64 screenshots).
  - The final full `bun run check` passed: runtime 494 unit tests, web 358, native integration 77/77, permuted
    profile 66/66, build, and strict lint with 0 findings. CI on `4c8c485` is green.
- Dev ran `ceab11e` in between. It no longer runs PR #4 (`spike/decisions`).
- `main` holds about 320 commits since `4ae7e63`, each with a `Behaviour delta:` line.

## What changed

- **Typed owner API (ADR 0038).**
  - One Effect HttpApi contract lives in `packages/contracts/src/api` and follows the myapps ADR 0013 design.
  - `OwnerApi` is served inside each user's agent (`http/api/server.ts`, behind `OwnerGate`). `AccountApi` (billing,
    clients and crash reports) is served in the Worker.
  - The Worker's `ownerForward` admits each request (origin, session, CSRF on every write, fresh plan check, 64 KB
    cap) and forwards `/api/*`.
  - The 71 hand-written Durable Object RPC methods and the `{ok, value|error}` envelope are gone; 5 RPCs remain.
  - Errors use the myapps envelope, carrying `ref`.
- **Web.**
  - Every read and write goes through per-feature `queries.ts` factories over the typed client, using the
    `lib/query` bridge ported from myapps.
  - Loaders prime the cache with `primeOwnerRead`. Owner pages suspend inside `QueryBoundary`.
  - The SSE stores only invalidate queries.
  - `boundary.ts`/`request()` is gone.
  - Every failure the owner sees quotes its ref.
- **Effect-native runtime.**
  - Every service is a `Context.Service` built by its area's layer. `layers/legacy.ts`, `services.ts`, `attempt` and
    `attemptSync` are gone.
  - The start keeps its original step order (`layers/index.ts`).
  - Programs run through one bridge (`runtime/bridge.ts`: `run`/`local`/`exit`/`runNow`). The Worker uses
    `runAtEdge`.
  - Each chat has one FIFO `KeyedLock`.
  - Areas talk through a `Changes` bus instead of listener sets.
- **Debuggability (ADR 0037).**
  - Logging: a content-free logger (`observability/logger.ts`). The failure reporter writes code-location frames;
    frames are no longer dropped.
  - Refs end to end: browser `x-goblin-request` → `x-goblin-ref` (cf-ray) → logs → `goblin lookup`.
  - Flow events go to the run ledger and to Analytics Engine (`FLOWS`, hashed agent). They cover:
    - send, reply, start, move and stop;
    - Personas, Delegates and Topics;
    - routines and Telegram;
    - client crashes.
  - New inspection: the per-message Details sheet, the `inspect_flows`/`inspect_details` tools, and the
    `goblin flows`/`stats`/`lookup` commands.
- **Conversation operations.**
  - A receipt per operation (`app_chat_operations`, an additive migration) with kind, origin, `parent_op` and state.
  - One admission sequence: `ChatOperations.send`.
  - One idempotent thread operation (reply, "+" and start), with the draft kept until the first send.
  - One stop path, and one chat-row inserter.
- **Bugs fixed:**
  - R1–R5: budget, routine gates and admission, the Events health check, and the 60 s plan cache.
  - C1–C4: composer errors, wait catch-alls, and double thread creation.
  - K1: unlocked memory writes.
  - M1–M7: 410 on transient failures, needs-auth, registry, content limit, and the wake.
  - H1–H3: personaOrder dropped, SchemaError mapped to 400, missing ref.
  - O1–O3: strict ledger decode, prefix-guessing for the source, error events ignored.
  - A1: the swallowed reconcile.
  - Eight web silent failures, including the session check that showed the sign-in form.
- **Lint.** The strict rule set is global:
  - `goblin/no-silent-catch`, `no-floating-promises`, the `no-unsafe-*` rules (off only in tests and scripts),
    `no-console` (logger, CLI, tools and scripts only), and the React hook rules;
  - the TanStack Query/Router rules and the myapps data-layer rules;
  - the Effect diagnostics are gated, and knip config hints are errors.
- **Dependencies.** effect 4.0.1, alchemy beta.81 and `@tanstack/react-query` 5.104.0, as in myapps.

## Morning steps for the owner

1. **Try dev.** Things to check:
   - the Details sheet in a message's toolbar;
   - the refs in errors;
   - reply and "+" threads.

   Then in a terminal, using the operator token:
   - `bun run goblin lookup <ref>`
   - `bun run goblin flows`
   - `bun run goblin stats`

   `stats` reads the Analytics Engine SQL API and needs **Account Analytics: Read** on `CLOUDFLARE_API_TOKEN`. It is
   untested against the live API because the conductor did not load secrets.
2. **Dev coding connections.** Last night's coding-runner quick tunnels have stopped, so the three dev coding
   connections show as unreachable. The dev smoke now records such a server as `probe: unreachable` instead of
   failing the release. Reconnect them, or add the Tunnel/DNS token scopes for the stable hostnames from last night's
   handoff.
3. **PR #4 (decisions).** It now needs porting onto the new shape: its `Decisions` service as a layer and its own API
   group. Dev no longer runs it.
4. **The other session's agent-config work** (`2a2b4e7` "Adopt the shared agent config standard") was on main and
   failed the Effect gate. With the owner's approval, `9e8b099` added a stated-reason directive to
   `scripts/agents-sync.ts`. That session's uncommitted edits in the shared checkout were left alone.

## Known gaps

- MCP: the host's token-refresh single-flight is still a per-server promise map. It runs inside the MCP SDK's Promise
  callbacks, so making it an Effect would need a nested run.
- `GET /api/mcp/catalog` does not yet expose the registry search's `partial` flag. That is a contract decision.
- `VITE_GOBLIN_BUILD` is not set by the release, so a crash report's build is `dev`.
- The native suite needs `bun run --cwd packages/app build` first; `bun run check` does this through turbo.
- `GLOSSARY.md` is missing the terms "Owner API", "Reference" and "Flow".
