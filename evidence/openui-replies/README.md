# Native interactive reply evidence

The implementation integrates complete `openui` fences with Goblin's existing Markdown renderer and conversation
send hook. The public playground imports that same renderer and records its synthetic follow-ups locally.

Preview: <https://goblin-openui-spike-preview.kristjan-grm11775.workers.dev>

## Native browser acceptance

The [native receipt](native-browser.json) records eight grouped checks at 1280px and 390px, with zero page errors.
These use the real `useConversation` hook with intercepted owner HTTP requests: keyboard submission, visible form
values, CSRF, pending lock, preserved values, unchanged retry operation ID, and each chat's own submission URL.
Quoted and closed replies disable their controls. Streaming, invalid source and render failures keep code;
HTML-like text remains inert, the development inspector stays absent, and no external requests occur.
Light/dark screenshots were inspected. This is local Chromium evidence, not a signed-in deployed conversation.

## Local repository gates

`heavy bun run check:fast` passed all 1,797 unit tests across eight test workspaces. The full gate reported zero
lint, Effect or Knip findings and zero collection failures; release-script, formatting, agent, patch, graph and
type checks passed. The native browser checks above and the six playground parser examples also passed.

Two full-gate attempts on the shared build box hit the existing 60-second timeout in
`native: a Topic's Conversation moves too, and 20 chained moves keep its reads within twice their cost`.
The first attempt passed all 76 ordinary workerd tests, then passed 69 of 70 permuted tests. The second passed
75 of 76 ordinary workerd tests and stopped there. Neither attempt reached the final build stage. The test and its
limits were not changed; the final PR's complete CI run on a fresh GitHub runner is the merge gate.

## GitHub CI

[The complete check at `057fa1c5`](https://github.com/grmkris/goblin/actions/runs/38820562680) passed on a fresh
GitHub runner: 22 release-script checks, 1,797 unit tests, 76 ordinary workerd tests, 70 permuted workerd tests and
all three production builds. Lint, Effect and Knip reported zero findings or collection failures. No tests were
failed or skipped; the dev/prod deployment jobs were intentionally skipped for this pull request.
The chained-move test completed in 8.9 and 9.3 seconds in those suites without any test or timeout changes.

## Scope

Pi's transcript, execution, authority and owner API are unchanged. The public preview has no accounts, model
endpoint, owner data, MCP grants or storage. Field edits and preview receipts reset on reload. Neither Goblin dev
nor prod is deployed by this work. Model generation reliability, token or latency savings, authenticated deployed
flows and physical-phone behavior remain unmeasured.

The earlier standalone spike evidence remains in `../openui-spike/`. Current implementation documentation is in
[chat blocks](../../docs/architecture/chat-blocks.md); preview reproduction and cleanup are in the
[playground README](../../apps/openui-spike/README.md).
