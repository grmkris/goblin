# Spike: cache-preserving browser fixtures

Status: working local vertical slice; adoption BLOCKED pending diagnosis of one queue startup timeout during concurrent repetitions. No merge or rollout is requested.

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
- No runtime architecture or schema decision changed, so no ADR or migration is introduced. No assertions, lint rules or timeouts were relaxed. Synthetic responses do not emit Playwright network response events; Start and landing retain explicit unexpected-API failure guards.

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

Use `--base . --candidate .` for this worktree-only spike: the default perf `--base HEAD` creates a scratch checkout elsewhere. The first browser/perf baseline ran before existing fixture code was edited. The warm baseline additionally uses original `perf/browser.ts` and `agui-route.ts` extracted with `git show 81ee73f:<path>` into this checkout’s `.local/cache-spike/`, adjusting only import paths. No stash or external worktree was used.

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

Each row ran `heavy bun --preload ./.local/cache-spike/observe.ts apps/web/test/ui-<name>.ts`. The driver uses monotonic wall time around that exact command, retries unchanged on heavy exit 75 and excludes contention retries from the reported first-run time. Cache counts sum resource-timing entries sampled at the browser load event, so late imports are outside that counter. The dedicated warm probe above samples at transcript ready.

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

Baseline failures were retained without changing their assertions:

- `ui-landing.ts`: the signed-in check times out waiting for `#channel`. The fixture directly renders Landing; the session redirect is now owned by the real route, not that component.
- `ui-local.ts`: the exact hover-color assertion samples a CSS transition after two animation frames; the base run already observed an intermediate color. This is an existing timing-sensitive assertion.

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

## Gate counts and remaining blocker

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

Queue deliberately retains genuine network routing. Only its comments changed; its shared AG-UI adapter did change, so a regression cannot be excluded. The draft stays BLOCKED until this outlier is explained or a bounded reproducer establishes and fixes the cause. Passing serial retries alone do not clear that blocker.

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

## Risks and production follow-up

- The change is test-only. Nothing was deployed or checked against dev/prod; production CDN behavior and real-device caching remain unverified.
- Review the synthetic fetch boundary before expanding it: it handles JSON/text, not browser cookies, redirects, CORS enforcement, binary transport or native network events. Retained network routes still disable cache for their entire page/context.
- The existing landing and hover fixtures need separate repair. Their red outcomes remain visible; this spike does not call the entire browser suite green.
- Investigate cold-open/heap differences before comparing application changes against historical perf numbers. Add paired/interleaved routing controls and more repetitions for a performance claim.
- Before rollout, review/merge the test-only changes through the normal dev PR flow, run the cache regression in the supported Chromium environment, and refresh perf baselines. An authenticated deployed browser/CDN check and any native EventSource transport tests need separate authorization and fixtures.
