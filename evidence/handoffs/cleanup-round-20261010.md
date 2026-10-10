# Cleanup round: the Effect migration finished, one router, the feed in Query, PR #4 ported: 2026-10-10

The plan, approved by the owner on 2026-10-10, is `~/.claude/plans/okay-let-s-go-grill-noble-muffin.md`. A conductor
session ran it in parallel lanes, all Claude subagents in their own worktrees, landing each by replay (rebase, gate,
fast-forward) with a canary after every land:

- **wave 0:** FA (helpers, seams, interfaces, pure moves) and FB (contracts, fixtures, the seven deletions), plus the
  web dialect and the Effect rules written down first;
- **wave 1:** T1 (tooling), H (HTTP and the internal API), M (MCP), R (routines and channel), C (conversation core and
  the stateless stores), D (delegation, workspace, apps) and W1 (the feed in Query);
- **the cut:** K (the bridge out of the agent's inputs, the workaround unions, the leftover instance tags);
- **wave 2:** T2 (integration tests), W2 (web consistency), P (PR #4) and X (docs and comments).

Lane briefs, status logs and gate logs are in `/tmp/goblin-lanes/cleanup-20261010/`; that directory is temporary and
not kept. `conductor/landed.md` there lists every land with its ready and landed commit.

## Where it stands

- `main` went from `2101696` to the docs lane's last commit: about 190 commits, each with a `Behaviour delta:` line.
  Nothing from this round is deployed yet: prod and dev still run `4c8c485`.
- Barrier checks (`heavy bun run check` in a fresh detached worktree) passed at B0 (`cef5c6a8`), B1 (`e2b61810`) and
  B2 (`19a15f32`). At B2: runtime 554 unit tests, web 489, native integration 79/79, the permuted profile 68/68, the
  build and strict lint with 0 findings. Lane P's gates on its tip (`70537a1f`, over `5404432e`) added native 81/81,
  permuted 70/70 and the browser fixtures 15/15.
- The `[canary]` native cases passed after every land. One canary run failed only on a port already in use (the
  lanes' harness ports overlapped); lanes moved to 100-port blocks and it passed again.
- The B3 full check, the releases and closing PR #4 are the conductor's; see Release.

## Release

- **B3** (`f6536733`): the full check passed: runtime 591 unit tests, web 499, native 81/81, the permuted profile 70/70,
  the build and strict lint.
- **CI.** Green on `04efb68a`, `53774279` and `12cedb2b`. The run for `12cedb2b` took four attempts, none of them a
  code failure:
  - the first two were OOM-killed in `ci.slice` while another repo's CI ran;
  - the third crashed one workerd stack on `SQLITE_BUSY` under load;
  - the fourth passed.
- **Dev:** `12cedb2b` is released (receipt `20261010T134347Z`), with the authenticated smoke and drift verified.
  `ui:acceptance` passed with 0 errors and 64 screenshots. Two earlier attempts failed:
  - **`04efb68a`.** The new `/internal` check expected the runtime's JSON 404, but the deployed web Worker answers
    `/internal/*` itself with its HTML not-found page. `53774279` accepts either kind of 404, and `12cedb2b` makes a
    failing inbound turn report its status and reason.
  - **`53774279`, and the first run of `12cedb2b`.** The Alibaba Token Plan's monthly quota was spent, so every dev
    model call answered `provider_error`. At the owner's direction, a parallel session moved dev's default, memory and
    smoke model to `muse-spark-1.3-contributor` through LiteLLM (`.local/dev.env`) and released the same SHA.
- **Not checked on dev:** a Clef decision proposal end to end.
- **Prod:** not released. It still runs `4c8c485` and waits for the owner. The range since then also holds a parallel
  session's client-performance commits.
- **PR #4:** closed with a comment that lists the port's commits (`1212538e`..`db5b9791`, docs `367ed1d2`).

## What changed

- **One router, one envelope** (ADR 0038, amended).
  - The agent serves the owner API and a new internal API (`InternalApi`, `/internal`, exported only from
    `@goblin/contracts/internal`) on one `AgentHttp` router. The Worker reaches the agent for inbound `/mcp` (ask,
    recent, inspect) and the two hooks (doorbell, MCP Events) through it, with a typed client over the stub's
    `fetch`. `InternalGate` refuses an owner forward and checks the cached plan (`RequiresPlan`, off for `inspect`).
  - The agent's raw routes are owner endpoints through `handleRaw`: a chat's event stream, a `workspace` group (the
    feed's stream), a `files` group (typed listing, streamed bytes) and `mcp.oauthCallback`, none renewing resident
    authority.
    `agent-requests.ts`, `errorBody` and the flat bodies are gone; every failure is the envelope.
  - The edge forwards only the owner's `/api/*` paths, as the parsed URL names them, marked `x-goblin-forwarded:
    owner`; the agent refuses an `/internal` path carrying the mark. `edge.test.ts` covers the `..`/`%2e%2e`
    variants; a workerd case and the smoke check `/internal` from outside.
  - One Durable Object RPC method is left, `deleteAgentData`.
  - Seven endpoints with no caller are gone: the Home group, the conversations, topics, personas and organize lists,
    and `mcp.getPrompt`. The middleware is `OwnerAdmission`; contracts are one module per area, with shared ids in
    `ids.ts`, one thread-operation schema and a catalog answer of `{ entries, partial }`.
- **The Effect migration finished.**
  - The conversation registry, mover, MCP host and manager, routines (`RoutineControl`), the Telegram channel, the
    workspace feed, Topics and skills are native services; the stateless stores (chat directory, switches, transcript
    index, memory, App registry, usage ledger) are functions of the agent's database. No `*Instance` tag is left.
  - Two ways into Effect: the bridge (`runtime/bridge.ts`, which `AgentInput` no longer carries) and
    `promiseWith(context)` (`runtime/boundary.ts`) for the MCP SDK's and the skills guard's callbacks; a lint closes
    both to the files `tools/graph.ts` lists. The Effect-to-Promise-to-bridge sandwiches are gone, and with
    them the four workaround unions: the services a program needs are inferred.
  - `SingleFlight` (in the core layer) runs MCP token refresh and connect, skills listings, a move's remaining steps,
    thread naming, the learner and a decision's judgment. `Entitlements` and `Resident` live in the core layer.
  - The start is twelve numbered steps, each saying why it awaits (`layers/index.ts`). Migrations run once, in the
    agent's constructor.
  - Shared helpers replace their copies: `attempt`/`attemptSync`, `epochSeconds`, `requirePlan`/`requireBudget`/
    `requireResident`, `sha256Hex`, `withFlow`, `ChatOperations.tracked`.
- **The web reads server state only through Query.**
  - The workspace feed writes one cache slice per kind under `['workspace', slice]`; the feed context and its three
    bridges are gone, `activity` is a plain record, and the browser fixtures count real renders: a conversation's
    change renders no App reader (`apps/web/test/ui-local.ts`). App keep and close are optimistic mutations re-applied
    over every stream write.
  - Factories take the cache from `context.client` (35 `useQueryClient` calls down to 5), keys are rooted at their
    feature, hooks live in `hooks.ts`, owner reads suspend inside the gate, the shims and the session and billing
    contexts are gone, one `withRef` quotes a failure's reference, the files over 300 lines are split, and there is
    one `lib/format.ts` and one `prefersReducedMotion`.
- **Tests and tooling.** One owner API fixture and typed client; a native probe registry with a table-driven
  `native.test.ts` (raw probe calls about 146 down to 14, each one the client cannot say); `as never` 57 down to 8;
  jscpd reads tests; dead lint globs gone, `any` banned everywhere, the Rules of React as errors; the smoke on the
  typed clients, with the build's commit and the flows dataset checked.
- **PR #4 ported** (ADR 0031): the `Decisions` service and layer, `POST /api/decisions/:id`, proposals in the feed
  and as "Only visible to you" rows, Clef metered as `clef`, its benchmark's pure code imported from
  `@goblin/runtime/decisions`. `AI` is bound on dev only, so prod runs the code inert.
- **Docs.** ADRs 0038, 0011, 0015, 0026, 0030, 0034, 0017, 0032, 0033, 0037, 0002 and 0035 amended; the
  architecture, development guide, README, glossary (now in the domain-modeling format), agent docs and skills say
  what the code does; stale lane, wave, plan-section and bug-id comments are gone from the source.

## Behaviour changes

- Hooks and inbound MCP no longer read the plan fresh in the Worker. The agent's internal gate reads the plan it keeps
  (an active plan for up to a minute), so a lapsed plan can reach the agent on these paths for up to a minute. No plan
  answers 402; an Events webhook whose plan lookup failed answers 503, so the producer retries.
- Every failure of the agent, the hooks and the Worker's fallback is the envelope; an unknown path is an envelope 404,
  and `/internal` from outside is 404.
- A move whose work fails leaves its receipt `refused` with the failure's type, not `admitted`. A stored running-turn
  swap that never settled reads as refused (`unsupported`), and the move receipt has no `mode`.
- A Telegram message arriving through Events is pulled from an immediate alarm, as a doorbell's is, not inside the
  webhook; the pull is serialised by the channel's own semaphore.
- An Events consumer handler that crashes retries its delivery, as a failed one already did; the "refreshed moments
  ago" check of an MCP token refresh runs inside its flight.
- An agent app's change reaches its App through the change bus just after the engine's step, not inline; a power used
  before the runtime is built waits for it instead of failing `starting`.
- The application tables are migrated once, in the agent's constructor, instead of three times.
- A deployed web bundle names its commit (`VITE_GOBLIN_BUILD`), so a crash report says which build crashed.
- The registry search says when a registry did not answer; adding and connecting a server, sending a message and
  signing out go through the mutation cache, so an expired session sends the owner to sign in.
- On dev, typed decisions propose highlights, thread drafts and earlier work for the owner to confirm or dismiss.

## For the owner

1. **The smoke's flows check.** It is skipped unless `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` reach the
   smoke's environment, and `release.py` does not pass them: decide whether it should.
2. **The shared checkout.** The untracked `apps/web/OVERNIGHT-HANDOFF-client-performance.md` (another session's) fails
   `fmt:check` there: move, format or delete it. Another session left about 140 skill and agent-config files staged
   there, with unstaged `.mcp.json`, `knip.jsonc`, `package.json` and `tools/agents.ts` edits; none of the lanes
   touched them.

## Known gaps

- A permuted native case, "main Stop preserves executing routines", is timing-sensitive under load; it passes alone.
- Under load, a workerd integration stack can crash with `SQLITE_BUSY` and take its file's cases down with it. The inbox
  case also failed once with a workerd `nodejs_compat` ConfigError. Both passed on rerun.
- **`muse-spark-1.3-contributor`, dev's model now, is flaky at Meta.** On 2026-10-10, 16 of 26 direct calls answered
  404 `model_not_found` while `muse-spark-1.3` and `-1.2` answered every call.
  - LiteLLM was given cooldown 0 and retry fallbacks for it.
  - The smoke's subagent step has no retry, so a 404 at the wrong moment fails a release.
- Two test comments still say "the owner gate" (`test/fixed-services.ts`, `test/http/api/apps.test.ts`), and two unit
  tests import integration fixtures (`inbox-docs.test.ts`, `queue.test.ts`); tests were outside the comment sweep.
- `ChatDirectory`, `CapabilityProfiles` and `ResidentAuthority` remain only for probes and fixtures, and the
  `check:chat-ids` guard still names `ChatDirectory`.
- The web keeps a few deliberate exceptions: the subscribe page polls with `useQuery`; the persona form, approval,
  capabilities, app powers and message details stay optional `useQuery` sections; the App stage's frame loop keeps its
  own `MediaQueryList`.
- Unchanged from before: compaction summaries are not counted toward the budget, and a turn's model and tool spans
  are created but not exported to Traces.
