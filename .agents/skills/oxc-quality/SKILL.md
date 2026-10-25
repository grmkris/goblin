---
name: oxc-quality
description: Configure or repair goblin's Oxlint, Oxfmt, Effect diagnostics, graph boundaries, Knip, duplication, and agent checks. Use for quality-gate work.
---

# goblin Oxc quality

Keep the MyApps quality families at zero new findings. Adapt paths and runtime zones to goblin; do not weaken a rule to clear a finding.

- Oxlint is primary; Oxfmt owns formatting. Keep correctness, suspicious, TypeScript type-aware, import, unicorn, Oxc, anti-slop, complexity, boundary, and project-invariant rules at error.
- Retain `require-safety-comment-for-type-assertion`, no chained assertions, no widening then asserting, no module mocking, no unknown returns, no reflection calls, and Effect tag/match rules. Every disable names the rule and ends with a concrete reason.
- Enforce 500 lines/file, 80 lines/function, depth 4, five parameters, and cognitive complexity 15. Test files may use the documented size/function exceptions; components may own narrowly scoped styling exceptions.
- `tools/graph.ts` is the runtime/import authority. Keep `apps/runtime` cloud, `apps/web` with explicit server/browser zones, `packages/contracts` shared, `packages/ui` browser, and tools tooling. Workspace manifest edges and graph edges must agree.
- Keep `process.env` out of runtime code; use Effect Config. Permit environment reads only in explicitly scoped test/build/tooling files.
- Run Knip, jscpd, and the TypeScript and Effect diagnostics (one effect-tsrs pass per project, `bun run typecheck`; ADR 0120) as separate gates. A checker that cannot resolve a project must fail, not report zero.
- `lint:gate` runs Knip as configured and in production mode (`bun run knip --production`, only what `knip.jsonc` marks with `!`), so code only tests use fails. Mark a new workspace's shipped sources with `!` and leave tests, fixtures and build scripts unmarked; an export kept on purpose carries `@internal` with its reason.
- New goblin code starts without a lint baseline. If a legacy finding is discovered, record the exact file/rule/reason and resolve it before merging.

Canonical commands are `bun run fmt:check`, `bun run agents:check`, `bun run graph`, `bun run dupes`, `bun run typecheck`, `bun run lint`, `bun run knip`, and `bun run test`; `check:files` is the inner loop. `heavy` is coordinator-owned.
