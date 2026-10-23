# Durable `code_run` with dquickts: spike results

Status: **working local/test spike, default off**. Path: **WASM inside the owning agent DO**. Spike 0's `dquickts-wasm/RESULTS.md` verdict was `WORKS`, including suspend → snapshot → fresh-instance restore → resume in local workerd. No native service hop was needed. No deployment, cloud mutation, secret, paid provider or live-stage acceptance was used.

## Problem and evidence

The Dynamic Worker `code_run` holds one of eight sandbox slots while awaiting its host. On this base, Pi marks it `replay: unsafe`: the existing recovery regression preserves a committed write and reports interruption. It cannot continue the script's heap. This differs from the brief's replay assumption. The earlier `spike/durable-codemode` at `1aa94bac` used Pi's `RemoteCodemodeSandbox`, a separate sandbox DO and deterministic replay (`git show 1aa94bac:apps/runtime/src/pi/codemode.ts`); it was read, not merged.

The implemented slice replaces only the opt-in `code_run` backend. Local integration reaches it through the real Pi tool and explicitly evicts/reconstructs the agent. Fake tools prove intact closure state and completed-effect reuse; real local SQLite/file storage proves the application boundary. It does not establish remote eviction or billing savings.

## What changed and decisions

- Vendored the pinned dquickts reactor (`f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406`), driver, WASI build script, patches and MIT license under [vendor/dquickts](vendor/dquickts/README.md). Artifact SHA-256: `e3abf1cd294d57a26e23ee232ccfeed6b2f4b00535b75be2d840b9e1f61bad71`.
- `DQUICKTS_CODE_RUN=spike` opts in only on `local`/`test`; `dev`/`prod` ignore it. No deployment config enables it. The default async Dynamic Worker executor stays in place.
- A synchronous TypeScript body calls `files.read/list/write`, `tools.call(connectionId,name,arguments)` and `log`. Each host boundary or compute quantum stores a base/delta heap checkpoint in new additive `app_code_runs`/`app_code_calls` tables, disposes WASM and releases the shared slot before waiting. Pi owns recovery and reenters with the same conversation/call id; it never replays completed calls. No vendor table or transaction spans a host wait.
- The intent/response journal borrows OC++'s rule: reuse completed responses; retry only known local read/list/yield operations; surface unfinished writes/MCP calls as `indeterminate`. MCP annotations never authorize retries. MCP dispatch still uses current resident authority, session scope, exact grants and existing Ask first refusal. Journal operation ids do not promise provider idempotency.
- Persistent cumulative limits: 30 seconds including downtime/host waits, 100 calls, 1,000 interrupt fuel units, 200 slices, 1 MiB raw snapshot bytes, 8 MiB QuickJS allocation cap and 32 MiB linear-memory maximum. Host JSON/file boundaries and output are bounded. A compute quantum is debited before execution; a crash cannot replenish fuel. The commit-gap unit test checks this reservation and completed-response reuse.
- Synchronous TypeScript is a deliberate restriction: async/await and Promise workflows are unsupported. Scripts have no imports, timers, network or Worker bindings. A suspended request still keeps the owning agent's invocation pending; the saved resource is the sandbox slot, not proven DO hibernation.

## Reproduce locally

Install dependencies first. All integration commands use the repository's `dev: true` Alchemy/workerd harness, deterministic model and synthetic hosts. No command below deploys.

```sh
heavy bun run --cwd apps/runtime typecheck
heavy bun run --cwd apps/runtime effect:check
heavy bun run --cwd apps/runtime test:unit
heavy bash vendor/dquickts/measure-baseline.sh e06aae34
heavy env GOBLIN_HARNESS_PORT=22861 bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
python3 vendor/dquickts/summarize.py e06aae340b9b942343ebc7c36b7e024a401a1897
```

The control script creates/removes its own checkout under `.local/durable-code`, adds only a test probe/registration and test, and leaves runtime source unmodified. It reuses installed dependencies. The final control ran before the final flagged measurements. Set `GOBLIN_BASELINE_PORT` or `GOBLIN_HARNESS_PORT` for port contention. `heavy` exit 75 is capacity contention; retries retained the command and never killed another job.

## Gates

Final observed receipts are summarized in [gates.txt](evidence/durable-code-2026-10-24/gates.txt). Test counts are final command summaries, not estimates.

| Gate                        | Exact command / receipt                                                                                                                                    | Result                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime typecheck           | `heavy bun run --cwd apps/runtime typecheck`                                                                                                               | exit 0                                                                                                         |
| Runtime Effect diagnostics  | `heavy bun run --cwd apps/runtime effect:check`                                                                                                            | exit 0; 0 findings in 766 files                                                                                |
| Full runtime unit suite     | `heavy bun run --cwd apps/runtime test:unit`                                                                                                               | exit 0; **1,217 passed**, 184 files; includes 17 dquickts tests                                                |
| Focused dquickts unit suite | `bun --cwd apps/runtime test:unit test/durable-code.test.ts`                                                                                               | exit 0; **17 passed**                                                                                          |
| Unmodified-base control     | `heavy bash vendor/dquickts/measure-baseline.sh e06aae34`                                                                                                  | exit 0; **1 passed**                                                                                           |
| Local workerd integration   | `heavy env GOBLIN_HARNESS_PORT=22861 bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts` | exit 0; **9 passed**, 2 files                                                                                  |
| Changed-file format/Oxlint  | complete `check:files --lint-only` command in gates.txt                                                                                                    | exit 0                                                                                                         |
| WASM rebuild/hash           | `heavy bash vendor/dquickts/build.sh .local/durable-code/source .local/durable-code/wasi-sdk`; `sha256sum -c vendor/dquickts/SHA256SUMS`                   | exit 0; repeated normalized build byte-identical; SHA check passes                                             |
| Repository standard gate    | `heavy bun run check`                                                                                                                                      | exit 1 at existing root fixture typecheck; preceding format, agent, patch, chat-id, terms and graph gates pass |
| Repository lint collector   | `heavy bun run lint:gate`                                                                                                                                  | exit 1; **2 existing fixture findings**, 0 collection failures; no spike findings                              |

The repository failures are in untouched `scripts/fixtures/mcp-app`: `server.ts` cannot resolve `@modelcontextprotocol/server`, causing two implicit-any errors; Oxlint reports its existing unused disable at line 26, and production Knip reports the fixture package dependency at line 11. They were not fixed or baselined away. A broad runtime integration attempt from the interrupted session did not produce a complete suite summary and is not claimed green. The targeted final run covers the change, actual Pi recovery, explicit eviction, eight suspended slots admitting a ninth job, uncertain effects, integrity/build rejection and cumulative limits. No browser behavior changed; no new browser acceptance is claimed.

An earlier full unit run exposed a timing-sensitive new test: its tiny deadline expired during WASM setup under suite load. The fixture now gives setup time and explicitly asserts the stalled host was invoked; the final full suite passes. Production limits were not relaxed.

## Measurements

Raw synthetic samples and computed medians are committed in [measurements.json](evidence/durable-code-2026-10-24/measurements.json), generated by `python3 vendor/dquickts/summarize.py e06aae340b9b942343ebc7c36b7e024a401a1897`. All values below are **measured**, with no billing estimate.

| Measurement                                                            | Baseline / dquickts                           | Command and boundary                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local DO elapsed wall, three sequential 50 ms host calls, five samples | **159 / 187 ms median**                       | baseline control then flagged integration commands above; time inside the DO around the whole executor call   |
| Same run: sandbox slot occupied                                        | **159 / 22 ms median**                        | same commands; sum only while `Isolates.call` callback owns a slot                                            |
| Recovery at third read vs fresh read-only replay, five samples         | **58 / 163 ms median**                        | flagged integration `durable-code-compare`; includes retrying the pending read, excludes eviction/startup     |
| Fresh DO after explicit eviction                                       | **6 ms**, one sample                          | flagged integration `durable-code-resume`; begins inside reconstructed DO, excludes startup and client retry  |
| Base / wrapped-workflow delta                                          | **13,063 / 3,945 bytes**                      | runtime unit command, nine fresh instances; raw engine bytes before base64                                    |
| Restore + resume                                                       | **0.957 ms median**, range **0.734–5.116 ms** | same nine Node unit samples; includes restore/input copies/resume, excludes instantiation and output decoding |
| WASM artifact                                                          | **754,236 bytes**                             | `stat -c '%s' apps/runtime/src/agent-apps/dquickts/engine.wasm`; SHA also computed by summarizer              |

The original executor exposes only files, so the fair before/after workload uses artificial delay at that shared `ScriptFiles` boundary; fake MCP tools separately cover suspension/effects/slot release. The baseline control is pinned to `origin/dev` revision `e06aae340b9b942343ebc7c36b7e024a401a1897`. Shared machine load makes the small timing samples noisy; no benchmark against another interpreter is implied. The repeat default-path probe is also preserved in the raw receipt.

**DO billing duration and Worker CPU were not measured.** Local DO elapsed wall increases here even as slot occupancy falls. A separate remote sandbox DO is absent from this implementation. Production billing, hibernation, end-to-end recovery latency including object startup, concurrent memory pressure, large-state scaling and upload acceptance require separate acceptance. The current delta is overwritten against a base; the journal grows per call. State-growth scaling was not benchmarked.

## Comparison (source bounded)

[S0] is the supplied Spike 0 results; [T] is `research-thdxr-2108579215897509951.md` ([public source](https://github.com/anomalyco/opencode/tree/09e6ddf/packages/codemode)); [D] is `research-devagrawal09-2113602679591371115.md` ([public source](https://github.com/devagrawal09/ocpp)); [M] is this spike's commands/receipts. The other interpreters were not benchmarked here.

| Approach               | Isolation                                                          | Memory / CPU limits                                                                            | Durability                                                                                          | Speed                                                                          | State size growth                                              | Workers fit                                             |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------- |
| dquickts [S0,M]        | WASM QuickJS; no script bindings/network; trusted server snapshots | Heap/linear caps, interrupt fuel and cumulative budgets [M]                                    | Base/delta heap + journal; unfinished unsafe calls become indeterminate [M]                         | 187 ms three-read median; 0.957 ms restore/resume median [M]                   | Base + current delta, per-call journal; scaling unmeasured [M] | Local workerd proven; deployed CPU/packaging unmeasured |
| @opencode/codemode [T] | Pure TS JS-subset interpreter in host thread                       | Timeout/call/output limits, unlimited by default; no memory cap found; regex can evade timeout | In-memory interpreter; no durable heap evidence                                                     | About 500× slower than native hot loop in supplied note; no QuickJS comparison | No persisted notebook/snapshot in supplied note                | Local workerd proven in note; production CPU unmeasured |
| OC++ [D]               | Custom interpreter; authority is granted host tools                | 512-value / 8 MiB notebook caps, not process-memory caps; CPU acceptance unestablished         | Immutable SQLite notebook + replay journal; retry reads, mark unsafe unfinished calls indeterminate | Author calls it very slow; no numeric baseline                                 | Named bounded notebook; currently reads every binding          | Local coding-agent design; Workers unverified           |
| quickjs-emscripten [T] | QuickJS WASM handle API; synchronous in-thread use supported       | Memory cap and deadline interrupt hook; threads optional                                       | No durable snapshot evidence in supplied note                                                       | Not measured here                                                              | No supplied snapshot/delta evidence                            | README claims Workers support; not tested here          |

## Risks and production rollout still needed

- Audit the QuickJS fork and C/WASM ABI, attest builds, validate engine CPU/memory under production-like concurrency and verify packaging acceptance. The bundle includes the WASM asset even when the runtime flag is off. Snapshots are trusted bytes tied to one build/host registry. SHA integrity detects corruption, not an attacker able to rewrite the database. Never accept client snapshots.
- Decide the synchronous language/API restriction. Host cancellation is not propagated: a timed-out effect may still finish, and its unknown outcome stays indeterminate. Exact read-only classification and provider-side reconciliation remain necessary. No exactly-once external effects are claimed.
- Review SQLite quotas, base64 write amplification, retention, pruning, compaction and snapshot upgrade/drain rules. Rows currently survive completed runs. The static C output buffer is bounded rather than a production dynamic ABI.
- The owning agent request remains pending on tools, and synchronous compute executes in that agent's Worker isolate. Slot release alone does not establish isolation from agent CPU stalls or reduced DO bills. Remote/native services, deployment and real-provider acceptance are outside this local spike.

[ADR 0115](docs/adr/0115-durable-code-run-with-dquickts.md) remains **proposed (spike)**. Production needs the reviews above, content-free metrics, staged rollout, rollback and snapshot draining before any flag is enabled there.
