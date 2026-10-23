# Spike: cache-preserving browser fixtures

Status: working local vertical slice; queue blocker cleared by the matched follow-up matrix below. The same startup failure reproduced on unmodified base before app/stream execution, while the branch passed every matched invocation. The PR remains draft; no merge or rollout is requested.

Base: `81ee73f01281d70f36349e4d361e77439fc87610`. Local Chromium fixtures only; no deployment, live-stage acceptance or paid model calls.

## Problem and evidence

Playwright routing disables Chromium HTTP caching and intercepts every request, including assets. Confirmed in the installed Playwright declarations (`Enabling routing disables http cache`) and `lib/coreBundle.js` (`Network.setCacheDisabled` and `Fetch.enable`), matching [Playwright documentation](https://playwright.dev/docs/api/class-page#page-route) and [issue 22865](https://github.com/microsoft/playwright/issues/22865).

The original perf fixture registered two network routes. Its static server emitted no Cache-Control, ETag or Last-Modified headers. Production already specifies immutable `/assets/*` in `apps/web/public/_headers`. Existing opening scenarios use fresh contexts, so they never measured a warm navigation. This spike adds that measurement; it does not reinterpret old cold samples as warm ones.

## What changed and decisions

- `mockRoute` uses `addInitScript` and a Playwright binding for same-origin JSON/text API fetches. Request data, delayed/stateful handlers, last-handler precedence and explicit native continuation are retained. Browser documents/assets stay native.
- The existing AG-UI fetch/ReadableStream simulator composes with the API stand-in in either init-script order and forwards Request signals. Its real reader/reducer/components are unchanged.
- The perf server mirrors the existing immutable asset policy; HTML revalidates and missing assets return `404 no-store`. The new cache runner includes routing and missing-header negative controls.
- API-only browser fixtures convert mechanically. Document rewrites, external popup/diagram guards, binary images/referrer checks and genuine send aborts retain network routing with comments. Those pages still have cache disabled.
- Native EventSource, XHR and WebSocket are deliberately outside this adapter. Current component fixtures disable the workspace EventSource feed and inject its snapshot; chat streams use fetch. Native workspace-feed transport needs a real local server fixture.
- No runtime architecture or schema decision changed, so no ADR or migration is introduced. No assertions or lint rules were relaxed. The follow-up replaces a fixed two-frame hover delay with a bounded wait for the same exact expected color; queue timeouts are unchanged. Synthetic responses do not emit Playwright network response events; Start and landing retain explicit unexpected-API failure guards.

Measured route-call sites fell from 54 on the base to 10 (retained network controls plus the new negative control). Commands: `git grep -n -F '.route(' 81ee73f0 -- apps/web/test` and `rg -n -F '.route(' apps/web/test`.

## How to run

Install workspace dependencies and the documented fixture dependencies first (`cd scripts/fixtures/mcp-app && heavy bun install --frozen-lockfile`). Build the app toolchain with `heavy bun run --cwd packages/app build` before the source fixtures.

```sh
heavy bun apps/web/test/ui-mock.ts
heavy bun apps/web/test/ui-cache.ts --assert
heavy bun apps/web/test/ui-perf.ts --base . --candidate . --reps 3 --scenarios open --profiles desktop
heavy bun apps/web/test/ui-follow.ts --assert
GOBLIN_HARNESS_PORT=28461 TURBO_CACHE=local:rw heavy bun run check
GOBLIN_HARNESS_PORT=28581 TURBO_CACHE=local:rw heavy bun run check:fast
```

Use `--base . --candidate .` for this worktree-only spike: the default perf `--base HEAD` creates a scratch checkout elsewhere. The first browser/perf baseline ran before existing fixture code was edited. The warm baseline additionally uses original `perf/browser.ts` and `agui-route.ts` extracted with `git show 81ee73f:<path>` into this checkout’s `.local/cache-spike/`, adjusting only import paths. No stash or external worktree was used for these original measurements. The queue follow-up below uses a disposable, unmodified base worktree with independently installed dependencies.

Exact commands, sample receipts, environment and per-load cache counts are in [measurements.json](evidence/cache-goblin-20261023/measurements.json). `<repo>` there replaces the private checkout prefix. The one-off measurement drivers and logs remain in `.local/cache-spike/`.

## Warm navigation measurements

Commands actually run: `heavy bun .local/cache-spike/probe.ts baseline <baseline-build>` and `heavy bun .local/cache-spike/probe.ts after <baseline-build>` use the same probe and built transcript, selecting the original or changed server/mock layer. Each opens a fresh desktop context, then navigates twice and reloads. `<baseline-build>` is this checkout’s `.local/goblin-perf/2026-10-23T20-37-44-perf/build-A`.

| Navigation | Baseline ready median (ms) | After ready median (ms) | Baseline cached assets per sample | After cached assets per sample | Baseline transferred asset bytes median | After transferred asset bytes median |
| ---------- | -------------------------: | ----------------------: | --------------------------------- | ------------------------------ | --------------------------------------: | -----------------------------------: |
| cold       |                       1295 |                  1038.1 | 0, 0, 0                           | 0, 0, 0                        |                               1,988,209 |                            3,725,531 |
| second     |                        901 |                   716.6 | 0, 0, 0                           | 17, 17, 17                     |                               1,795,845 |                                    0 |
| reload     |                      960.8 |                   620.9 | 0, 0, 0                           | 17, 17, 17                     |                               1,795,845 |                                    0 |

Cache validity also passed the asserted runner:

| Command (common prefix below)             | Samples | Warm cached assets per sample | Result |
| ----------------------------------------- | ------: | ----------------------------- | ------ |
| `ui-cache.ts --assert`                    |       9 | 17, 17, 17, 17, 17, 17        | exit 0 |
| `ui-cache.ts --assert --route-control`    |       9 | 0, 0, 0, 0, 0, 0              | exit 0 |
| `ui-cache.ts --assert --no-cache-headers` |       9 | 0, 0, 0, 0, 0, 0              | exit 0 |

The exact common invocation was `heavy bun apps/web/test/ui-cache.ts --dist <baseline-build> --out .local/cache-spike/<mode>-receipt.json --assert`, plus the listed control flag. Missing asset responses were asserted as `404 no-store` in each run. Cache hits use `transferSize === 0 && decodedBodySize > 0`; CDP requestServedFromCache events are also recorded, but miss some disk-cache responses and are not the cache-hit oracle.

These are local, sequential, shared-box samples, not a causal latency benchmark. Lazy imports can finish before or after the ready sample, so observed asset counts differ between cold and warm pages and between transport modes. Both routing removal and cache headers are needed for warm cache hits. No speedup is claimed.

## Existing perf harness before/after

Baseline command: `heavy bun --preload ./.local/cache-spike/observe.ts apps/web/test/ui-perf.ts --base . --candidate . --reps 3 --scenarios open --profiles desktop`. After command: `heavy bun apps/web/test/ui-perf.ts --base . --candidate . --reps 3 --scenarios open --profiles desktop`. Both variants in each run are the same app source, giving the within-run noise floor. The table pools their samples at each requested part count. The observer records load-time resource counts without routing or changing cache state.

| Requested parts | Baseline ready median (ms) | After ready median (ms) | Baseline heap median (MB) | After heap median (MB) |
| --------------: | -------------------------: | ----------------------: | ------------------------: | ---------------------: |
|             100 |                      958.6 |                  1056.5 |                      24.1 |                   31.2 |
|             200 |                     1245.2 |                  1419.9 |                      29.1 |                   36.3 |
|             400 |                     1990.9 |                  2387.8 |                      39.5 |                   46.3 |
|             800 |                     3368.3 |                  3869.2 |                      60.3 |                   66.5 |
|            1600 |                     5316.5 |                  6388.6 |                     100.7 |                  109.9 |

Cold opens were slower and used more heap in the after run. The browser now loads chunks natively, and the synthetic API bridge also changes harness overhead. Shared load and asynchronous asset loading prevent attributing these differences to cache alone. Keep the receipts as a new harness baseline. Stream/scroll/idle performance was not benchmarked; streamed behavior was tested by the follow runner.

## Browser suites and repetitions

The following table preserves the original spike measurements through `4c3e0704`, before the hover repair and traced queue follow-up. Each row ran `heavy bun --preload ./.local/cache-spike/observe.ts apps/web/test/ui-<name>.ts`. The driver uses monotonic wall time around that exact command, retries unchanged on heavy exit 75 and excludes contention retries from the reported first-run time. Cache counts sum resource-timing entries sampled at the browser load event, so late imports are outside that counter. The dedicated warm probe above samples at transcript ready.

| Suite       | Baseline seconds / exit | After seconds / exit | Baseline / after cached resources at load | Repetition exits |
| ----------- | ----------------------- | -------------------- | ----------------------------------------- | ---------------- |
| apps        | 14.93 / 0               | 15.43 / 0            | 0 / 99                                    | 0, 0, 0          |
| channel     | 25.43 / 0               | 28.8 / 0             | 0 / 498                                   | 0, 0, 0          |
| composer    | 5.4 / 0                 | 5.42 / 0             | 0 / 0                                     | 0, 0, 0          |
| connections | 32.41 / 0               | 23.31 / 0            | 0 / 1011                                  | 0, 0, 0          |
| events      | 25.0 / 0                | 23.84 / 0            | 0 / 0                                     | 0, 0, 0          |
| grant       | 51.71 / 0               | 43.26 / 0            | 0 / 407                                   | 0, 0, 0          |
| grants      | 8.7 / 0                 | 7.6 / 0              | 0 / 0                                     | 0, 0, 0          |
| holds       | 16.77 / 0               | 11.57 / 0            | 0 / 0                                     | 0, 0, 0          |
| jump        | 20.65 / 0               | 15.44 / 0            | 0 / 0                                     | 0, 0, 0          |
| landing     | 57.71 / 1               | 52.73 / 1            | 0 / 0                                     | 1, 1, 1          |
| local       | 13.05 / 1               | 17.18 / 1            | 552 / 546                                 | 1, 1, 1          |
| message     | 9.0 / 0                 | 9.46 / 0             | 0 / 261                                   | 0, 0, 0          |
| navigation  | 57.08 / 0               | 64.3 / 0             | 0 / 0                                     | 0, 0, 0          |
| openui      | 9.52 / 0                | 10.95 / 0            | 0 / 0                                     | 0, 0, 0          |
| queue       | 19.2 / 0                | 21.4 / 0             | 0 / 0                                     | 0, 0, 1          |
| setup       | 10.68 / 0               | 12.91 / 0            | 0 / 0                                     | 0, 0, 0          |
| sources     | 11.62 / 0               | 13.58 / 0            | 0 / 0                                     | 0, 0, 0          |
| start       | 67.01 / 0               | 70.02 / 0            | 0 / 1158                                  | 0, 0, 0          |

First-run timings are not normalized for Vite transforms, machine load or cache state outside each context. Only completed attempts are recorded; interrupted attempts resumed from saved receipts. Repetition timings are in the raw receipt and are used to check outcomes, not speed.

The original baseline failures were:

- `ui-landing.ts`: the signed-in check times out waiting for `#channel`. The fixture directly renders Landing; the session redirect is now owned by the real route, not that component.
- `ui-local.ts`: the exact hover-color assertion sampled a CSS transition after two animation frames; the base run already observed an intermediate color. The test-only follow-up repair and its results are below.

## Gates

| Actual command                                                                                           | Result           |
| -------------------------------------------------------------------------------------------------------- | ---------------- |
| `heavy bun apps/web/test/ui-mock.ts`                                                                     | exit 0; 2.88 s   |
| `heavy bun run --cwd apps/web typecheck`                                                                 | exit 0; 21.92 s  |
| `heavy bun apps/web/test/ui-perf.ts --base . --candidate . --reps 3 --scenarios open --profiles desktop` | exit 0; 146.5 s  |
| `heavy bun apps/web/test/ui-follow.ts --assert`                                                          | exit 0; 236.35 s |
| `cd scripts/fixtures/mcp-app && heavy bun install --frozen-lockfile`                                     | exit 0; 0.24 s   |
| `heavy bun run check`                                                                                    | exit 1; 11.42 s  |
| `GOBLIN_HARNESS_PORT=28461 TURBO_CACHE=local:rw heavy bun run check`                                     | exit 0; 575.96 s |
| `GOBLIN_HARNESS_PORT=28581 TURBO_CACHE=local:rw heavy bun run check:fast`                                | exit 0; 134.82 s |

Final evidence/documentation check: `bun run check:files SPIKE_RESULTS.md evidence/cache-goblin-20261023/measurements.json .agents/skills/runtime-tests/SKILL.md docs/development.md` passed with exit 0 in 28.53 s (the checker wraps expensive steps in `heavy` internally).

The first standard `check` stopped because the fresh checkout lacked `scripts/fixtures/mcp-app` dependencies. Its lockfile install is part of the repository’s CI setup; the subsequent full check is reported separately. Scoped `check:files` passed format, lint, web typecheck and Effect checks for the helper and converted fixtures; the helper check also passed agents/docs validation.

## Original gate counts and queue incident

Full `check` includes typecheck, Oxlint/Effect/Knip, formatting, graph/duplication checks, tests, local workerd integrations and builds. Turbo local caching was enabled; this is a successful gate result, not a claim that every cached task executed afresh.

| Check (within the full command above)           |             Passed | Failed |
| ----------------------------------------------- | -----------------: | -----: |
| Web unit tests                                  |    757 in 96 files |      0 |
| Runtime unit tests                              | 1,200 in 183 files |      0 |
| Regular local integration                       |      90 in 5 files |      0 |
| Permuted local integration                      |      84 in 2 files |      0 |
| New `heavy bun apps/web/test/ui-mock.ts` checks |                  7 |      0 |

Final owned-file validation passed format (29 files), lint (27 files), web/root typecheck and Effect, and agents/docs checks over 31 explicit paths. Its expanded `heavy bun run check:files` invocation is in `gates.current-files-final` in measurements.json; its wall time was not recorded. An earlier invocation accidentally checked zero files and is excluded from gate evidence.

| Browser pass (the 18 suites listed above) | Passed | Failed |
| ----------------------------------------- | -----: | -----: |
| baseline                                  |     16 |      2 |
| after                                     |     16 |      2 |
| repeat-2                                  |     16 |      2 |
| repeat-3                                  |     15 |      3 |

The measured source-fixture scope is the 18 suites listed above, not every `ui-*.ts` script. `ui-diagram.ts` and `ui-markdown.ts` retain their routes and gained explanatory comments only; they are outside the timing comparison.

Opening performance completed 30 samples before and 30 after. Follow behavior completed 14 scenarios before and 14 after, both with exit 0. Baseline follow command: `heavy bun --preload ./.local/cache-spike/observe.ts apps/web/test/ui-follow.ts --assert`; after: `heavy bun apps/web/test/ui-follow.ts --assert`. Exact wall times are in `browserRuns.baseline` and `gates.follow-after`.

The third concurrent repetition of `ui-queue.ts` timed out after 30,000 ms at `full.locator('[data-submission="5"]').waitFor()` before the initial snapshot appeared. It passed on the original baseline and the first two after passes. Its load-event observer recorded 41 resources versus 250 in passing loads; the saved fixture receipt contained zero page errors and no completed matrices. This is evidence of incomplete startup, not proof of a Vite or adapter cause. No timeout or assertion was changed.

Queue deliberately retains genuine network routing for send aborts. Only its comments changed in the original spike; its shared AG-UI init script did change, so the draft was initially marked BLOCKED. The matched base/current follow-up below now establishes that this startup failure class predates that change. Queue never installs `mockRoute` or its binding.

A serial diagnostic alternated the original queue/AG-UI fixtures extracted from the base with the current fixture. Import paths alone changed in the extracted copy; it uses the same app source and Vite configuration. Both variants used a diagnostic preload that records browser errors, failed requests and closing state. Initial extraction attempts failed module resolution; those setup errors are excluded from this comparison.

| Variant  | Repetition | Seconds | Exit |
| -------- | ---------: | ------: | ---: |
| baseline |          1 |   18.27 |    0 |
| current  |          1 |   21.01 |    0 |
| baseline |          2 |   24.67 |    0 |
| current  |          2 |   18.48 |    0 |
| baseline |          3 |   16.33 |    0 |
| current  |          3 |   18.19 |    0 |

Exact commands are in `queueDiagnostics` in measurements.json. These serial outcomes cannot establish whether the concurrent failure existed before this spike.

## Queue follow-up: matched serial and concurrent reproduction

The base was an unmodified detached worktree at `81ee73f01281d70f36349e4d361e77439fc87610`, with its own `heavy bun install --frozen-lockfile`. Candidate source was `8357530b4dc846ecc59183fa4cbd0b46b97c359b`; its only follow-up source change is the hover wait. Tracked base files were unchanged. The disposable base worktree was removed after evidence collection.

| Queue invocations                      | Base passed | Base failed | Branch passed | Branch failed |
| -------------------------------------- | ----------: | ----------: | ------------: | ------------: |
| Serial                                 |          20 |           0 |            20 |             0 |
| Ten batches of four concurrent workers |          39 |           1 |            40 |             0 |
| Total                                  |          59 |           1 |            60 |             0 |

These are complete suite invocations, each normally exercising all viewport/theme matrices, not individual assertions. The same observer records console messages, page errors, failed requests, closing state and Playwright traces on both sides. The existing Vite `port: 0` mechanism allocates an independent ephemeral port per worker. Every concurrent batch had four distinct actual ports and all four workers overlapped; recorded overlap ranges from 31.91 to 89.7 seconds. Each bounded four-worker batch holds one `heavy` slot, avoiding per-worker lock contention serializing the intended workload. Exit 75 retries the unchanged command.

Commands actually run by `python3 .local/cache-spike/queue-matrix.py`:

```sh
# Serial, run from each side; <side> is the corresponding worktree.
heavy bun --preload <side>/.local/cache-spike/queue-stress-observe.ts apps/web/test/ui-queue.ts
# Each phase is base or current; each batch is 1 through 10, run from the spike worktree.
heavy python3 <repo>/.local/cache-spike/queue-matrix.py batch <phase> <batch>
# Each batch launches four workers from the selected side inside that heavy gate:
bun --preload <side>/.local/cache-spike/queue-stress-observe.ts apps/web/test/ui-queue.ts
```

The observer was copied into each worktree so it imports that side's Playwright instance. [queue-followup.json](evidence/cache-goblin-20261023/queue-followup.json) records every command, exit, wall time, timestamp, actual port, batch gate and sanitized diagnostics. Initial dependency/observer-resolution attempts and extra individually throttled runs are excluded from this equal-sample matrix. Completed receipts were reused after interruptions, never counted twice. Raw traces/logs remain local because they contain private filesystem paths and Vite connection tokens.

### Failure diagnosis and limits

Base run `parallel-base-4-1` timed out at the same initial `[data-submission="5"]` wait after 30,000 ms, in its fourth viewport/theme matrix. Its failing-page trace shows:

- 67 JavaScript module requests failed with `net::ERR_NETWORK_CHANGED`; console errors report the same cancellations.
- The page body was empty, the stream marker absent, and there were zero `/__fixture/streams/` opening requests.
- The AG-UI init script installation completed before navigation. No API mock binding is installed by queue.
- Three `net::ERR_FAILED` messages and three 503 console messages belong to earlier intentional abort/removal scenarios; they are distinct from the startup module cancellations.

The proximate cause is a Chromium network-change cancellation during module loading, before app boot or stream fixture execution, on unmodified base. The host event that triggered Chromium's notification is unknown; this trace does not establish a Vite optimizer race. Trace SHA-256: `062d3281d41652ed01ebf88ee6dd2e333b5be5ca5495f2f6dcb9d9a624a4b4f6`.

This establishes a pre-existing startup flake, with no adapter-attributable failure observed in the matched branch sample. It supports removing the adoption BLOCKED label without changing the adapter, adding a readiness handshake, retrying failures away or increasing queue timeouts. It does not prove the flake is impossible on the branch. The original incident had no trace, so its precise network error cannot be identified retrospectively. Its 41-resource load-time observation is not comparable to this run's 250-resource close-time count, which includes failed entries.

### Baseline fixture follow-up

The hover test now waits up to 3,000 ms for the unchanged exact expected computed color instead of sampling after two animation frames. This is a test-only synchronization repair; the final equality assertion remains. The first `heavy bun apps/web/test/ui-local.ts` attempt failed after 52.91 seconds at a later hybrid-page startup wait; its desktop and phone hover checks had already passed. It had no trace, so that separate startup error remains unclassified. Three subsequent traced commands, `heavy bun --preload ./.local/cache-spike/hover-observe.ts apps/web/test/ui-local.ts`, passed all 15 checks each in 68.58, 36.14 and 47.1 seconds.

Landing remains unchanged and red: its bare `Landing` component fixture cannot exercise the Home route's signed-in session/workspace decision. A correct repair needs a route-level harness. Removing its assertion or reproducing app navigation logic in the fixture would weaken coverage. The development guide now describes that limitation accurately.

### Fresh gates after the hover source change

| Actual command                                                            | Result           |
| ------------------------------------------------------------------------- | ---------------- |
| `GOBLIN_HARNESS_PORT=28691 TURBO_CACHE=local:rw heavy bun run check`      | exit 0; 491.1 s  |
| `GOBLIN_HARNESS_PORT=28691 TURBO_CACHE=local:rw heavy bun run check:fast` | exit 0; 136.75 s |

The full gate includes typecheck, Oxlint/Effect/Knip, formatting, graph/duplication, tests, local workerd integrations and builds. It reports 757 web unit, 1,200 runtime unit, 90 regular local integration and 84 permuted local integration tests passed, with zero failures in those groups. Local Turbo caching was enabled, so cached tasks are not claimed as fresh execution. Scoped checks also passed for the hover source change. Final docs/evidence validation passed with exit 0 in 13.08 seconds: `bun run check:files SPIKE_RESULTS.md evidence/cache-goblin-20261023/queue-followup.json docs/development.md`. It wraps expensive steps in `heavy` internally.

## Risks and production follow-up

- The change is test-only. Nothing was deployed or checked against dev/prod; production CDN behavior and real-device caching remain unverified.
- Review the synthetic fetch boundary before expanding it: it handles JSON/text, not browser cookies, redirects, CORS enforcement, binary transport or native network events. Retained network routes still disable cache for their entire page/context.
- Landing still needs a route-level fixture. The pre-existing network-change startup failure and the untraced hybrid startup failure remain documented; this spike does not call the entire browser suite green. The hover timing assertion is repaired and repeated successfully.
- Investigate cold-open/heap differences before comparing application changes against historical perf numbers. Add paired/interleaved routing controls and more repetitions for a performance claim.
- Before rollout, review/merge the test-only changes through the normal dev PR flow, run the cache regression in the supported Chromium environment, and refresh perf baselines. An authenticated deployed browser/CDN check and any native EventSource transport tests need separate authorization and fixtures.
