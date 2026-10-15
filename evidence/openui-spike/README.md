# OpenUI spike evidence

Preview: <https://goblin-openui-spike-preview.kristjan-grm11775.workers.dev>

The public fixture playground uses `@openuidev/react-lang` 1.0.1 with ten Goblin components. Its isolated Alchemy
plan created one static-assets Worker, `goblin-openui-spike-preview`, with no storage or account/model bindings.

## Preview acceptance

- Six parser/library tests passed, with no failures or skips.
- The local built preview passed 22 Chromium checks with no failures.
- The deployed Worker passed the same 22 checks with no failures. See [the receipt](deployed-browser.json).
- Desktop (1440px) and phone emulation (390px) covered filtering, empty results, form values, source editing,
  invalid input, partial-stream rendering, reload, and page fit. Light/dark screenshots were reviewed.
- No page errors or external requests were observed during those checks.
- HTTP returned 200. CSP, no-referrer, and nosniff headers were present. The entry HTML and JavaScript matched
  Alchemy's `dist/client` build byte for byte.
- Deployed entry: `index-BtKhBbE1.js`, SHA-256
  `6c1cc23ef8d260acec73f4eaa2c80cc2baafef52b6c109d23776141bf50f3669`.

The entry chunk is 526,424 bytes minified and the lazy chart chunk is 419,002 bytes. Vite emits a chunk-size warning.
These are artifact measurements, not an OpenUI-versus-Goblin performance comparison.

## Repository gates

- `heavy bun run check:fast`: passed (13 tasks).
- `heavy bun run check`: passed; zero lint/Effect/Knip findings or collection failures.
- Release-script checks: 22 passed.
- Unit tests: 1,755 passed across eight test workspaces, including the six spike tests.
- Local workerd integrations: 76 passed in the ordinary suite and 70 passed in the reordered suite.
- Production builds: all three build tasks passed. No failed or skipped tests were reported.
- Base: `dev` at `6c04e81256d4890cbd20ca8f5a328c9c94d26097`, refreshed before the final gate.

## Evidence boundary

This proves fixture rendering and component compatibility on the deployed preview. It does not establish live
model generation reliability, token savings, latency improvement, resident-agent integration, authenticated flows,
or physical-phone behavior. Actions remain in browser memory. Goblin dev/prod were not deployed by this spike.

The [app README](../../apps/openui-spike/README.md) has reproduction and cleanup instructions. Runtime screenshots,
full gate logs, and Alchemy state are retained locally, outside the public source tree.
