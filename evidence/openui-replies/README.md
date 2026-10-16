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

The [deployed receipt](deployed-browser.json) records 22 checks with zero failures at desktop and phone widths after the final theme fix. The live HTML and entry JavaScript matched the Alchemy build byte for byte (a 1,188,259-byte entry at the time); the [artifact record](deployed-artifact.json) now describes the redeployed build below.

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

## Review fixes (2026-10-16)

An independent review of the PR head `10340b18` found three blockers, fixed in `cdeb9c42`, `50752d00` and `e7324cbd`:

- OpenUI strips comments and fences before parsing and the checker did not. A 378-character reply hiding a
  second `root` after `pad = #'` passed the checks, and parsing it took 15 seconds and 4.7 GB. The Renderer now
  draws the checked program printed back.
- Hidden text could be sent as the owner's words: labels clipped in nowrap buttons, no-break-space padding,
  Unicode tag characters, and long text defaults.
- Enter in a field sent the first card's choice when the form had several buttons.

The native browser receipt then recorded ten grouped checks at 1280 px and 390 px with zero page errors: the eight
above, plus Enter beside several buttons, a wrapped long label, a typed 250 in a 100–5000 field, and focus returning
after a send. The playground's built-site check passed 22 of 22. The preview was then redeployed from the dev release
`0c539e15` (Alchemy plan: one in-place update), and its deployed check passed 22 of 22 again. The
[deployed receipt](deployed-browser.json) and [artifact record](deployed-artifact.json) now describe that build, whose
entry carries the new text rules.

## Scope

Pi's transcript, execution, authority and owner API are unchanged. The public preview has no accounts, model
endpoint, owner data, MCP grants or storage. Field edits and preview receipts reset on reload. Neither Goblin dev
nor prod is deployed by this work. Model generation reliability, token or latency savings, authenticated deployed
flows and physical-phone behavior remain unmeasured.

The earlier standalone spike evidence remains in `../openui-spike/`. Current implementation documentation is in
[chat blocks](../../docs/architecture/chat-blocks.md); preview reproduction and cleanup are in the
[playground README](../../apps/openui-spike/README.md).
