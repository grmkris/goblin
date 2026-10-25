# User-facing punctuation release, 25 October 2026

The owner-approved copy rule replaces five shipped em dash strings with ordinary punctuation, preserves arbitrary
remote/test content, and permits only the named empty-cell marker. The quality instructions also prohibit speculative
complexity without the user's buy-in. The decision lives in `docs/agents/lint-quality.md`, following the repository's
existing lint-rule documentation convention; no new ADR or migration was needed.

`heavy bun run check` passed at `ae294d2bc3b657dc8fedd29eba1ee0be1ccc8aff` after the evidence rebase, including unit tests, both native integration
orders, the zero-finding lint/Effect/Knip gate and the build. A standalone MCP fixture dependency installation was
required in the fresh worktree. No product source change was needed for that setup issue.

[Dev CI](https://github.com/grmkris/goblin/actions/runs/40149924606) passed. `dev.json` retains the accepted SHA,
live Worker version, authenticated acceptance, drift result and migration inventory from its `dev-acceptance` artifact.

The production promotion command passed every preflight and moved prod to the runtime release
`6fb76978f2f59fa1e9fb72df5bced252d0d0e67f`. Later tooling and evidence changes remain on dev.
[Production CI](https://github.com/grmkris/goblin/actions/runs/40148148163) passed, including public production
acceptance and verified drift. `prod.json` preserves its sanitized `prod-acceptance` receipt.

The production promotion ran under the overnight repository lock. The current promotion script, development runbook
and recent release history contained no Swarmm acceptance prerequisite. No manual deploy or reset was performed.
