# Trusted workloads OIDC spike results

## Problem

Goblin server callers currently authenticate with long-lived `gbk_` API keys. Swarmm's current contract sends
`GOBLIN_API_KEY`, while GitHub Actions and other platforms can issue short-lived OIDC tokens. The spike asks whether a
workspace owner can save an exact OIDC trust policy and let those workloads use the same narrowly scoped Goblin grant
through HTTP and MCP.

## Evidence before the change

- `apps/runtime/src/auth/api-keys.ts` verifies Better Auth `gbk_` secrets and resolves the existing server grant.
- `apps/runtime/src/http/api/principal.ts` forwards that grant as the server credential.
- `apps/runtime/src/mcp/key-origins.ts`, ADRs 0091, 0103 and 0105, and ADR 0114 make grant reach, MCP origins,
  rotation and lifetime authoritative.
- Swarmm's requested wire contract is HTTPS issuer, same-origin JWKS, ES256 with `kid`, `aud` equal to Goblin's runtime
  origin and `sub=swarmm:<stage>`.

The unmodified base `81ee73f0` was checked in a temporary worktree at
`/tmp/goblin-oidc-baseline-20261023`. After frozen installs at the root and in the MCP app fixture, its
`heavy bun run check:fast` passed (exit 0). Turbo replayed all 14 successful test tasks from the shared worktree cache;
this is a cached baseline result, not a fresh timing benchmark. The initial attempt lacked the fixture's nested
dependencies and failed an unused-disable check; the corrected baseline passed without changing source.

## What changed

- Added the shared `OidcPolicy` contract and exact validator/matcher. HTTPS public issuers, required `aud`, exact claim
  strings, array intersection, bounded discovery and fixed error codes are enforced.
- Added auth D1 migration `0006_trusted_workloads.sql` for workspace policies and hashed exchanged tokens. Policies
  attach to a live existing server grant; owners/admins can list, create, disable and optionally retire its static key.
- Added jose ES256/RS256 verification with exact issuer, signature, time, subject, audience and claims checks. Discovery
  and JWKS are same-origin public HTTPS, 64 KiB bounded, five-second timed, cached for five minutes and issuer-bounded
  to 64 entries with ten-second failed-discovery backoff.
- Added direct JWT Bearers on `/api` and `/mcp`, plus RFC 7523 `/token` exchange to random `gbw_` opaque Bearers. The
  exchange stores only SHA-256 hashes, claims each `iss+jti` once and ends at the earliest of five minutes, assertion
  expiry and grant expiry. Scope/resource escalation is refused.
- Advertised `io.modelcontextprotocol/oauth-client-credentials` on MCP. The installed SDK 2.3.1 providers were inspected;
  the test uses its `PrivateKeyJwtProvider` only to hold the exchanged token because Goblin's platform assertion grant
  is explicit JWT bearer exchange.
- Added Settings → Trusted workloads with adapted GitHub branch and custom issuer/Swarmm forms, policy list and disable.
- Marked workload principals so persistent Events webhook leases are refused until the lease model binds policy and
  bearer lifetime. Polling remains grant-scoped.
- Added local issuer fixtures and runtime/native/browser tests. No real provider token, cloud call or workflow changed.

Workspace selection is deliberately claim-free: the runtime indexes policies by the JWT's unverified `iss`, verifies all
candidates, and requires exactly one active matching policy. The match's workspace is the only source of the agent id.

## How to run

All commands are local and use ephemeral fixtures. Do not supply production environment files.

```sh
heavy bun run --cwd apps/runtime test:unit test/workloads/principal.test.ts test/workloads/verifier.test.ts
GOBLIN_HARNESS_PORT=22701 heavy bun run --cwd apps/runtime test:integration owner.test.ts -t 'trusted workloads'
heavy bun apps/web/test/ui-workloads.ts
heavy bun run --cwd apps/runtime typecheck
heavy bun run --cwd apps/web typecheck
heavy bun run --cwd packages/contracts typecheck
heavy bun run --cwd packages/app build
```

## Gate results

| Gate                               | Command                                                                                                            | Result                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Runtime typecheck                  | `heavy bun run typecheck` (cwd `apps/runtime`)                                                                     | PASS (exit 0)                                                                                            |
| Web typecheck                      | `heavy bun run typecheck` (cwd `apps/web`)                                                                         | PASS (exit 0)                                                                                            |
| Contracts typecheck                | `heavy bun run typecheck` (cwd `packages/contracts`)                                                               | PASS (exit 0)                                                                                            |
| Full lint / Effect / Knip          | `GOBLIN_HARNESS_PORT=22701 heavy bun run check`                                                                    | PASS: `lint:gate: 0 findings, 0 collection failures`                                                     |
| OIDC verifier/principal unit tests | `heavy bun run --cwd apps/runtime test:unit test/workloads/principal.test.ts test/workloads/verifier.test.ts`      | PASS (2 files, 24 tests)                                                                                 |
| Runtime full unit suite            | `GOBLIN_HARNESS_PORT=22701 heavy bun run check`                                                                    | PASS (185 files, 1,224 tests)                                                                            |
| Web full unit suite                | `GOBLIN_HARNESS_PORT=22701 heavy bun run check`                                                                    | PASS (96 files, 757 tests)                                                                               |
| Native trusted workload test       | `GOBLIN_HARNESS_PORT=22701 heavy bun run --cwd apps/runtime test:integration owner.test.ts -t 'trusted workloads'` | PASS (1 passed, 31 skipped)                                                                              |
| Native full integration            | `GOBLIN_HARNESS_PORT=22701 heavy bun run check`                                                                    | PASS (5 files, 91 tests; plus 2 permuted files / 85 tests)                                               |
| Browser policy form                | `heavy bun apps/web/test/ui-workloads.ts`                                                                          | PASS (8 saved, 4 disabled; 1440/390 px, light/dark; no page errors or overflow)                          |
| App artifact                       | `heavy bun run --cwd packages/app build`                                                                           | PASS (exit 0)                                                                                            |
| Base fast gate                     | `heavy bun run check:fast` in the temporary base worktree                                                          | PASS (exit 0; 14 test tasks cached)                                                                      |
| Spike fast gate                    | `heavy bun run check:fast`                                                                                         | PASS (exit 0; 14 successful test tasks, 11 cached)                                                       |
| Spike full gate                    | `GOBLIN_HARNESS_PORT=22701 heavy bun run check`                                                                    | PASS (exit 0; 14 unit tasks, 5 integration files / 91 tests, 2 permuted files / 85 tests, 3 build tasks) |

The browser command renders the actual source components and validates submitted bodies with the shared schema, using
fake API responses. Its screenshots are under `.local/goblin-acceptance/workloads-1792793786541`. Native coverage uses
real local workerd, auth D1 migrations and PersonalAgent with ephemeral issuer keys and injected discovery/JWKS. It
checks both GitHub-style and Swarmm-contract JWTs through HTTP and the official MCP client, static-key retirement,
exchange, replay refusal, scope ceiling, policy disable and webhook refusal. Unit negatives also cover wrong
subject/audience/repository/ref, expiry, unknown issuer, bad signature, deleted policy/grant, concurrent replay,
ambiguous trust, private/HTTP issuers, discovery limits and cache refresh.

The first full-check process was interrupted by the model-capacity restart before it returned an exit status. The restarted
full gate completed successfully; its receipt is `full-complete.json` in the ignored local evidence directory.

The first spike fast run found two outdated test expectations (the migration inventory and a JWT bearer returning a
route miss). Both were corrected to assert the new behavior; the full unit suites above pass. No lint rule or gate was
weakened. Raw command receipts stay under ignored `.local/oidc-spike` and are not committed because they contain local
paths and synthetic runtime logs.

## Measurements

| Measurement                 | Command                                                                                      | Base                              | Spike                             |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| Source revision             | `git rev-parse HEAD` in each tree                                                            | `81ee73f0`                        | `81ee73f0` plus this PR's changes |
| Runtime unit tests          | `heavy bun run check:fast` on base; `GOBLIN_HARNESS_PORT=22701 heavy bun run check` on spike | 1,200 passed / 183 files (cached) | 1,224 passed / 185 files          |
| Web unit tests              | same commands                                                                                | 757 passed / 96 files (cached)    | 757 passed / 96 files             |
| Native workload slice       | focused native command above                                                                 | absent                            | 1 passed / 31 skipped             |
| Policy-form browser fixture | browser command above                                                                        | absent                            | 8 saves / 4 disables              |

No latency or throughput claim is made. Gate wall times under shared-machine contention and different cache states
would not be a useful before/after performance comparison. The measured before/after is gate behavior and test coverage;
all added issuer traffic stays inside local fixtures.

## Risks and open questions

- Local fixtures prove cryptography and routing, not GitHub or Swarmm availability, key rotation, DNS behavior, or a
  deployed Worker. Network egress and trusted DNS remain an assumption.
- Exact one-policy matching is fail-closed but an overlapping policy in another workspace denies both. Production needs
  an explicit ambiguity resolution and audit path.
- Policies are attached to a static-key grant, so a grant must be created before trust. A production design may give
  workload identities their own grant id and audit events.
- Direct assertions are reusable until expiry; only `/token` exchange is jti-replay protected. A future replay control
  needs a bounded jti store for direct requests, with the throughput/availability trade-off documented.
- The current Events lease table is grant-scoped. Workloads can poll but cannot subscribe webhooks; policy-bound leases
  and delivery-time revocation are required before enabling that path.
- The custom form accepts one exact `sub`; advanced GitHub environments, reusable workflows and immutable repository IDs
  need a reviewed form. The UI does not discover issuers on save.

## Production rollout still needed

1. Security review the policy UX, grant identity, issuer allowlist, discovery/JWKS cache, replay and ambiguity behavior.
2. Add audit records, quotas, cleanup/retention for token hashes and policy changes, and operational metrics without
   logging token or claim content.
3. Validate additive migration against a populated dev backup and run issuer/key-rotation acceptance against controlled
   GitHub and Swarmm test issuers. No production or dev acceptance was run for this spike.
4. Add a reviewed CI smoke change with `id-token: write`, exact repository/ref/environment policies per stage, and a
   rollback that disables trust; migrate Swarmm dispatches and retire the static secret only after evidence.
5. Design policy-bound Events leases, a workload-native grant lifecycle and an official MCP SDK assertion provider path.

Status: local synthetic and native fixture evidence only; proposed spike, not a deployment recommendation.
