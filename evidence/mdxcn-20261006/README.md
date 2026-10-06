# mdxcn local acceptance — 2026-10-06

Local synthetic Chromium and workerd evidence for the curated mdxcn figures. No deployment, model calls or owner
accounts were used. Upstream MIT source: `shadcn-labs/mdxcn` at
`16d817ad5ec54d89142e4c1cf26027b60d6df853` (see `packages/kit/vendor/mdxcn/`).

## Browser receipt

[receipt.json](receipt.json) records the assertions, with zero page errors. The fixture uses the real chat
components and theme, then loads the built `core.js` and `mdxcn.js` in an opaque frame with network disabled.

- All five figures render in [light](light.png) and [dark](dark.png) themes.
- At a [320px viewport](narrow.png), page width stays 320px. Comparisons scroll inside their frames; timelines and
  stats adapt to the pane.
- Reduced motion changes entrance animation to `none`.
- Open streaming fences remain code, close into figures, and preserve the earlier figure's DOM node.
- Invalid, unknown, empty and unclosed specs remain code. A component throw falls back to the original code.
- Tool output and shared-note Markdown stay code. Unavailable frame imports are rejected.

The fixture and runner were retained during the session in `/tmp/goblin-mdxcn-acceptance-20261006/`; those temporary
files are not a permanent test harness. Screenshots show synthetic display data.

## Check boundary

- Kit parser/render tests: 23 passed. Focused web fence, text, tool Markdown and sandbox tests: 30 passed.
- `check:files` passed formatting, lint, typecheck, Effect and agent-doc checks for the implementation paths.
- `heavy bun run build` and `heavy bun run dupes` passed.
- Real local workerd acceptance passed the agent-app view test, which imports and executes both `Stat` and
  `mdxcnSpec`, selects the mdxcn bundle, rejects unavailable imports and checks deterministic render failures.
  The routine reconstruction test also passed on its fresh-port retry: 2 passed, 37 skipped. A prior full runtime
  run had 49/50 pass with an unrelated routine socket failure.
- Final `heavy bun run check` passed format, agents, patches and graph checks, then failed web typechecking in the
  concurrent, unowned `apps/web/src/components/home/drag.ts`: missing `useRef` arguments at lines 31 and 32, and
  assigning `undefined` to `Gesture` at lines 75 and 86. Other workspace typechecks passed. This is not a green root
  gate; the remaining root stages were not reached in that run.

No database migration or dependency was added. Deployed and real-model acceptance remain unrun.
