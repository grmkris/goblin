# Chromium cache fixture acceptance, 25 October 2026

[PR 13](https://github.com/grmkris/goblin/pull/13) moves same-origin API fixture fetches into an init-script adapter.
Documents and assets use Chromium networking; genuine aborts and navigation guards retain their network routes.
The production fixture server gives hashed assets the same immutable policy as the application.

This receipt supersedes the spike's raw JSON and cold performance baseline. Raw logs stay in ignored local storage.
These are local synthetic fixtures, with no account or model calls; they do not prove deployed CDN or device behavior.

## Historical limitations

The spike's matched queue runs passed 59/60 times on unchanged base and 60/60 on its branch.
The captured base failure cancelled JavaScript requests with `net::ERR_NETWORK_CHANGED` before application startup.
The host trigger is unknown; no retry, readiness workaround or timeout increase was added.

`ui-landing.ts` times out waiting for `#channel` on base too: it renders the bare Landing component while signed-in
navigation belongs to the Home route. That existing fixture failure is outside this change. The spike also recorded
an unclassified hybrid-page startup timeout. This receipt does not call every browser fixture green.

## Reproduction

```sh
GOBLIN_HARNESS_PORT=29671 TURBO_CACHE=local:rw heavy bun run check
heavy bun apps/web/test/ui-mock.ts
heavy bun apps/web/test/ui-cache.ts --assert
heavy bun apps/web/test/ui-cache.ts --assert --route-control
heavy bun apps/web/test/ui-cache.ts --assert --no-cache-headers
heavy bun apps/web/test/ui-perf.ts --base . --candidate . --reps 3 --scenarios open --profiles desktop
```

The two perf variants contain identical application code. Their interleaved samples measure the refreshed harness
baseline and shared-host noise, not a performance improvement. Only compare future application changes within a run.

## Refreshed cold baseline

Chromium 156.0.8078.4. Thirty interleaved cold samples, three per variant and size.

| Parts | Ready median (ms) | Heap median (MiB) |
| ---: | ---: | ---: |
| 100 | 827.0 | 29.5 |
| 200 | 1188.3 | 36.1 |
| 400 | 1651.2 | 46.0 |
| 800 | 2852.7 | 66.5 |
| 1600 | 4812.1 | 110.1 |

The warm probe passed nine navigations in three fresh contexts. All six warm loads reused 17/17 hashed assets
with zero transferred asset bytes. The cold loads transferred assets, as expected.
