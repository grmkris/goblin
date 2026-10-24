# Durable `code_run` with dquickts: spike results

Status: **working local/test spike, default off**. Paths: **selectable WASM in the owning agent DO or a native child process over authenticated loopback HTTP**. Spike 0's `dquickts-wasm/RESULTS.md` verdict was `WORKS`. WASM remains available; the native follow-up moves synchronous compute out of the agent isolate. Both retain snapshots in the owning DO. No deployment, cloud mutation, real secret, paid provider or live-stage acceptance was used.

## Problem and evidence

The Dynamic Worker `code_run` holds one of eight sandbox slots while awaiting its host. On this base, Pi marks it `replay: unsafe`: the existing recovery regression preserves a committed write and reports interruption. It cannot continue the script's heap. This differs from the brief's replay assumption. The earlier `spike/durable-codemode` at `1aa94bac` used Pi's `RemoteCodemodeSandbox`, a separate sandbox DO and deterministic replay (`git show 1aa94bac:apps/runtime/src/pi/codemode.ts`); it was read, not merged.

The implemented slice replaces only the opt-in `code_run` backend. Local integration reaches it through the real Pi tool and explicitly evicts/reconstructs the agent. Fake tools prove intact closure state and completed-effect reuse; real local SQLite/file storage proves the application boundary. It does not establish remote eviction or billing savings.

## What changed and decisions

- Vendored the pinned dquickts reactor (`f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406`), driver, WASI build script, patches and MIT license under [vendor/dquickts](vendor/dquickts/README.md). Artifact SHA-256: `e3abf1cd294d57a26e23ee232ccfeed6b2f4b00535b75be2d840b9e1f61bad71`.
- `DQUICKTS_CODE_RUN=spike` opts in only on `local`/`test`; `dev`/`prod` ignore it. No deployment config enables it. The default async Dynamic Worker executor stays in place.
- A synchronous TypeScript body calls `files.read/list/write`, `tools.call(connectionId,name,arguments)` and `log`. WASM checkpoints each host boundary or compute quantum in new additive `app_code_runs`/`app_code_calls` tables, disposes its instance and releases the shared slot before waiting. The native option below checkpoints host boundaries in the same tables. Pi owns recovery and reenters with the same conversation/call id; it never replays completed calls. No vendor table or transaction spans a host wait.
- The intent/response journal borrows OC++'s rule: reuse completed responses; retry only known local read/list/yield operations; surface unfinished writes/MCP calls as `indeterminate`. MCP annotations never authorize retries. MCP dispatch still uses current resident authority, session scope, exact grants and existing Ask first refusal. Journal operation ids do not promise provider idempotency.
- WASM persistent cumulative limits: 30 seconds including downtime/host waits, 100 calls, 1,000 interrupt fuel units, 200 slices, 1 MiB raw snapshot bytes, 8 MiB QuickJS allocation cap and 32 MiB linear-memory maximum. Host JSON/file boundaries and output are bounded. A compute quantum is debited before execution; a crash cannot replenish fuel. The commit-gap unit test checks this reservation and completed-response reuse.
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

The original WASM receipts are summarized in [gates.txt](evidence/durable-code-2026-10-24/gates.txt). Test counts are final command summaries, not estimates.

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

## Original WASM measurements

Original synthetic samples and computed medians are committed in [measurements.json](evidence/durable-code-2026-10-24/measurements.json), generated by `python3 vendor/dquickts/summarize.py e06aae340b9b942343ebc7c36b7e024a401a1897`. All values below are **measured**, with no billing estimate.

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

**DO billing duration and Worker CPU were not measured.** Local DO elapsed wall increases here even as slot occupancy falls. A separate remote sandbox DO is absent; the optional native process described below is not a DO. Production billing, hibernation, end-to-end recovery latency including object startup, concurrent memory pressure, large-state scaling and upload acceptance require separate acceptance. The current delta is overwritten against a base; the journal grows per call. State-growth scaling was not benchmarked.

## Native follow-up: implementation and security

The native option uses the same pinned upstream and shared embedding driver, built by `heavy bash
vendor/dquickts/build-native.sh .local/durable-code/source`. Binary SHA-256:
`27ab5d6c5f400b9db980e9dcafaba1a2bc905204e2d1b104587e5bf065e656cd`.
The native build id hashes the binary **and** controller source; both are pinned in the native measurement receipt.
The build script and source are committed; the native binary is rebuilt locally.

`DQUICKTS_ENGINE=wasm|native` selects the backend inside the existing local/test flag. Unset is WASM; without
`DQUICKTS_CODE_RUN=spike`, the original async executor is still used. The native URL, bearer and expected build are
in `DQUICKTS_NATIVE_URL`, `DQUICKTS_NATIVE_TOKEN`, `DQUICKTS_NATIVE_BUILD`. Tests generate a local bearer, start the
service, inject those bindings and stop only their spawned controller. No CI or real secret is changed.

The Python stdlib controller binds **only 127.0.0.1** on an ephemeral port, with no public/tailnet override. The
Worker accepts only loopback HTTP and does not follow redirects. Constant-time bearer verification protects all
operations. Snapshots are MACed with a derived key over build, run, base/delta and integer CPU counters. The
service validates the MAC/build before native restore; the DO also validates its source/build/checkpoint digest.
Neither client snapshots nor script-provided URLs are accepted. Controller/same-user host and trusted server
snapshots remain part of the security model. Loopback HTTP does not protect against a privileged local observer.

Every `/eval`, `/resume`, `/snapshot`, `/restore` request forks/execs a fresh native child with empty environment and
closed extra descriptors. The token never enters the native exec image. Snapshots return to the owning DO's
existing `app_code_runs` SQLite row as sealed JSON; the service keeps no run state. Native snapshots are bounded
including that envelope. The existing per-call journal and `indeterminate` policy apply unchanged.

Before exec: 128 MiB `RLIMIT_AS`, `RLIMIT_CPU`, fractional `ITIMER_PROF`, wall timer and no core dumps. Parent `wait4`
measures user+system child CPU. The driver installs fail-closed x86_64 seccomp before input: socket calls fail with
EPERM; exec/spawn/ptrace are denied. There are no script file/network bindings. This denylist is not a complete OS
sandbox against an engine memory-safety exploit. QuickJS retains its 8 MiB allocator limit. The controller
serializes requests; throughput/concurrent admission hardening is deferred.

The default cumulative native CPU budget is 1,000 ms. SQLite reserves min(remaining, 200 ms) **before** HTTP, passes
20 ms less and refunds unused reservation only from a successfully acknowledged measured CPU result. Lost replies
forfeit their reservation; eviction cannot replenish CPU. A MACed service counter independently caps acknowledged
CPU across restoration. The service arms the timer another 10 ms early for startup/tick granularity. A long
compute slice that cannot reach a host call in its allowance terminates instead of taking another compute quantum.
Timer granularity is not a hard real-time guarantee. Controller CPU and Worker CPU are outside this accounting.
Wall deadline, host/step limits, acknowledged fuel and snapshot limits persist across native checkpoints; CPU
reservations are the crash-safe compute budget for this backend.

Reproduce (after the pinned source preparation in [vendor/dquickts](vendor/dquickts/README.md) and the original
base-control command above, which the measurement summarizer also reads):

```sh
heavy bash vendor/dquickts/build-native.sh .local/durable-code/source
GOBLIN_DQUICKTS_ENGINE=native GOBLIN_HARNESS_PORT=23261 heavy bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
GOBLIN_HARNESS_PORT=22861 heavy bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
heavy bun --cwd apps/runtime test:unit
python3 vendor/dquickts/summarize-native.py
```

## Native follow-up: measured results

All entries below are **measured local synthetic results**, not estimates. Raw samples and the summarizer output
are in [native measurements](evidence/durable-code-native-2026-10-24/measurements.json). Commands are the reproduction
commands above: native integration writes `.local/native` and `native-*` receipts; WASM integration writes `wasm-*`;
the unit suite writes WASM operation timings. Samples run on a shared machine and are noisy.

| Boundary                                                        | WASM                     | Native                               | Evidence/meaning                                                                                                              |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Three sequential artificial 50 ms file reads, DO elapsed median | 206 ms                   | 243 ms                               | Five samples per engine, whole executor inside DO; original base control was 159 ms                                           |
| Same workload, occupied sandbox-slot median                     | 31 ms                    | 71 ms                                | Slot callback duration; original base control was 159 ms                                                                      |
| Resume at third read / fresh replay, median                     | 57 / 164 ms              | 68 / 165 ms                          | Five samples; pending read included, object startup excluded                                                                  |
| After explicit DO eviction, resume inside fresh object          | 8 ms                     | 21 ms                                | One sample per engine; excludes object startup/client retry                                                                   |
| CPU-heavy sum loop elapsed median                               | 160 ms                   | 43 ms                                | Five workerd samples per engine; same script and result                                                                       |
| Same loop, maximum agent timer delay median                     | 159 ms                   | 6 ms                                 | **Blocking proxy**, not Worker CPU ms; timer runs in the owning agent                                                         |
| Eval / snapshots / restore+resume, engine timing median         | 0.604 / 0.784 / 1.088 ms | 0.332 / 0.971 / 0.494 ms             | Nine samples; WASM in Node, native in child; native snapshot timing includes initialization, WASM snapshot timing excludes it |
| Native HTTP eval / snapshot / restore / resume median           | n/a                      | 15.911 / 12.900 / 14.774 / 13.534 ms | Nine samples; controller + fork/exec + serialization included; snapshot endpoint restores then re-snapshots                   |
| Raw base / delta                                                | 13,063 / 3,945 bytes     | 13,063 / 3,945 bytes                 | Same wrapped workflow; MAC/JSON/base64 envelope excluded; growth scaling unmeasured                                           |
| Child CPU after four suspensions then infinite loop             | Interrupt fuel only      | 88.007 ms / 100 ms budget, SIGPROF   | `wait4` sum over five child processes; native CPU test; SQLite test also refuses a subsequent rerun with zero remaining CPU   |

Kernel probes observed socket **EPERM (1)**, a 256 MiB allocation refused under 128 MiB `RLIMIT_AS` with **ENOMEM
(12)**, a script memory bomb ending `InternalError: out of memory`, and wall termination by **SIGALRM (14)**. These
are allocation rejection and clean script failure, not an observed OOM-killer signal. CPU termination was
**SIGPROF (27)** with fuel raised so the native kernel timer, rather than the JS interrupt counter, ended the loop.

The original all-budget reservation made mid-compute eviction unrecoverable; bounded reservations fixed that
during implementation. A profiling-timer trial exceeded its requested budget by startup/tick overhead; the final
test requires measured CPU <= budget with conservative margins. HTTP trials exposed connection failures; the
final controller explicitly closes responses and the Worker uses supported manual redirect handling. Final
functional tests pass; no production reliability or billing claim follows from these small samples.

**DO billing and Worker CPU ms remain unmeasured.** Native child CPU is actual OS accounting. Agent timer delay
only measures event-loop responsiveness. The owning DO invocation still waits on hosts/HTTP; slot release does
not prove hibernation or a smaller bill. Strong OS isolation, service authentication/transport outside loopback,
key rotation/build draining, controller admission/backpressure, host cancellation and retention need production work.

## Native follow-up: gates and base verification

Sanitized exact-command receipts and exit codes are in [native gates](evidence/durable-code-native-2026-10-24/gates.txt).

| Gate                           | Command                                                                 | Result                                                     |
| ------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Native build                   | `heavy bash vendor/dquickts/build-native.sh .local/durable-code/source` | exit 0                                                     |
| Full runtime unit suite        | `heavy bun --cwd apps/runtime test:unit`                                | exit 0; 1,217 passed, 184 files                            |
| WASM local workerd             | WASM integration command above                                          | exit 0; 9 passed, 2 files                                  |
| Native local workerd + service | Native integration command above                                        | exit 0; 14 passed, 2 files                                 |
| Runtime typecheck              | `heavy bun --cwd apps/runtime typecheck`                                | exit 0                                                     |
| Runtime Effect                 | `heavy bun --cwd apps/runtime effect:check`                             | exit 0; 0 findings in 770 files                            |
| Changed-file format/Oxlint     | Full `heavy bun run check:files --lint-only …` in receipt               | exit 0                                                     |
| Standard repository gate       | `heavy bun run check`                                                   | exit 1 at the same MCP fixture typecheck                   |
| Fast repository gate           | `heavy bun run check:fast`                                              | exit 1 at the same fixture unused-disable lint error       |
| Repository lint collector      | `heavy bun run lint:gate`                                               | exit 1; same 2 fixture findings, 0 collection failures     |
| Unmodified base standard gate  | `heavy bun run check` in detached base checkout                         | exit 1; same unresolved module and two implicit-any errors |
| Unmodified base lint collector | `heavy bun run lint:gate` in detached base checkout                     | exit 1; same 2 fixture findings, 0 collection failures     |

The detached base was **e06aae340b9b942343ebc7c36b7e024a401a1897**, the PR's dev base and original control revision.
Only dependency symlinks were added; tracked source diffs before/after both gates were empty. The temporary
checkout was created under this worktree's ignored `.local/native` and removed afterward. The reproducible
[base-gates.sh](evidence/durable-code-native-2026-10-24/base-gates.sh) and sanitized logs preserve this proof. Those
failures are pre-existing; they were not suppressed or counted as passing. A full unfiltered runtime integration,
permuted suite, browser e2e and build after the root failure are not claimed run by this follow-up.

## Comparison (source bounded)

[S0] is the supplied Spike 0 results; [T] is `research-thdxr-2108579215897509951.md` ([public source](https://github.com/anomalyco/opencode/tree/09e6ddf/packages/codemode)); [D] is `research-devagrawal09-2113602679591371115.md` ([public source](https://github.com/devagrawal09/ocpp)); [M] is this spike's commands/receipts. The other interpreters were not benchmarked here.

| Approach               | Isolation                                                                  | Memory / CPU limits                                                                            | Durability                                                                                          | Speed                                                                          | State size growth                                                    | Workers fit                                                               |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| dquickts WASM [S0,M]   | WASM QuickJS in agent isolate; no script network                           | Heap/linear caps and interrupt fuel; CPU ms unmeasured                                         | Base/delta + journal; unfinished unsafe calls indeterminate                                         | Original 187 ms three-read median; current operation timings above             | Base + current delta and per-call journal; scaling unmeasured        | Local workerd proven; deployed CPU/packaging unmeasured                   |
| dquickts native [M]    | Fresh limited child outside agent; loopback bearer; seccomp network denial | RLIMIT_AS/CPU + kernel timers; measured child CPU; conservative cumulative reservations        | MACed base/delta in DO + same journal; service stateless                                            | 243 ms three-read median; 13.534 ms HTTP restore+resume median                 | Same raw base/delta size here; JSON/MAC envelope; scaling unmeasured | Local workerd + Linux service proven; no cloud service routing/acceptance |
| @opencode/codemode [T] | Pure TS JS-subset interpreter in host thread                               | Timeout/call/output limits, unlimited by default; no memory cap found; regex can evade timeout | In-memory interpreter; no durable heap evidence                                                     | About 500× slower than native hot loop in supplied note; no QuickJS comparison | No persisted notebook/snapshot in supplied note                      | Local workerd proven in note; production CPU unmeasured                   |
| OC++ [D]               | Custom interpreter; authority is granted host tools                        | 512-value / 8 MiB notebook caps, not process-memory caps; CPU acceptance unestablished         | Immutable SQLite notebook + replay journal; retry reads, mark unsafe unfinished calls indeterminate | Author calls it very slow; no numeric baseline                                 | Named bounded notebook; currently reads every binding                | Local coding-agent design; Workers unverified                             |
| quickjs-emscripten [T] | QuickJS WASM handle API; synchronous in-thread use supported               | Memory cap and deadline interrupt hook; threads optional                                       | No durable snapshot evidence in supplied note                                                       | Not measured here                                                              | No supplied snapshot/delta evidence                                  | README claims Workers support; not tested here                            |

## Risks and production rollout still needed

- Audit the QuickJS fork and C/WASM ABI, attest builds, validate engine CPU/memory under production-like concurrency and verify packaging acceptance. The bundle includes the WASM asset even when the runtime flag is off. Snapshots are trusted bytes tied to one build/host registry. SHA integrity detects corruption, not an attacker able to rewrite the database. Never accept client snapshots.
- Decide the synchronous language/API restriction. Host cancellation is not propagated: a timed-out effect may still finish, and its unknown outcome stays indeterminate. Exact read-only classification and provider-side reconciliation remain necessary. No exactly-once external effects are claimed.
- Review SQLite quotas, base64 write amplification, retention, pruning, compaction and snapshot upgrade/drain rules. Rows currently survive completed runs. The static C output buffer is bounded rather than a production dynamic ABI.
- The owning agent request remains pending on tools, and WASM synchronous compute executes in that agent's Worker isolate. Slot release alone does not establish isolation from agent CPU stalls or reduced DO bills. The native follow-up measures an agent timer-lag proxy; billing, deployment and real-provider acceptance remain unverified.

[ADRs 0115](docs/adr/0115-durable-code-run-with-dquickts.md) and [0116](docs/adr/0116-native-dquickts-service.md) remain **proposed (spike)**. ADR 0116 adds the native option without rewriting ADR 0115. Production needs the reviews above, content-free metrics, staged rollout, rollback and snapshot draining before any flag is enabled there.
