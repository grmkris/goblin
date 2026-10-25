# ADR 0121: tsrs only: the tsgo fallback is gone, and effect-tsrs moves to 0.2.2

Status: Accepted 2026-10-25 (owner: "let's have it everywhere; if we're at the same parity, the `EFFECT_CHECKER=tsgo`
fallback can be dropped"). Amends ADR 0120. Changes how `bun run typecheck` and the Effect gate run; no runtime change.

## Context

ADR 0120 moved the TypeScript and Effect diagnostics onto one effect-tsrs pass per project and kept
`EFFECT_CHECKER=tsgo`, the old pair of tsc and effect-tsgo, as a fallback until 2026-11-08. Parity was exact on every
project, and the same move landed in the owner's other repositories the same night with the same result.

`@yielded/effect-tsrs` 0.2.2, a day newer than the pinned 0.2.0, bundles the same tsrs (rev 8f135f1) and aligns its
file coverage with effect-tsgo 0.56.1. It reports the TypeScript diagnostics only when asked (`--type-check`).

## Decision

**The fallback is removed** (2026-10-25, after parity). `bun run typecheck`, `lint:gate` and `lint:report` run
effect-tsrs and nothing else; `EFFECT_CHECKER` is no longer read, and turbo no longer hashes it. Nothing in the gates
runs tsc or effect-tsgo. To restore the fallback, revert the commit that removed it (`tools: the EFFECT_CHECKER=tsgo
fallback is gone; …`).

**What stays installed, and why.** `typescript` 7.0.2 stays in each workspace and `@effect/tsgo` in `tools`: editors
run the TypeScript language service and the Effect plugin from them, reading the same tsconfig block. knip ignores
`@effect/tsgo`, which no script runs.

**effect-tsrs 0.2.2, pinned exactly.** `tools/effect.ts` passes `--type-check`, so one run still reports what tsc
reports beside the Effect diagnostics. 0.2.2 reports Effect diagnostics on a project's own files only, as effect-tsgo
did, so ADR 0120's note that a file imported across workspaces is checked again in each importer no longer holds. It
counts the files it checks without the plugin again (`summary.filesWithoutPlugin`), which `uncheckedFiles` turns into a
failure beside the tsconfig read before the run. It honours `singleThreaded: true` from tsconfig.base.json, so each pass
still runs on one thread.

## Evidence

The parity method of ADR 0120 reran on 0.2.2 against tsc 7.0.2 and effect-tsgo 0.54.0 on all 12 typecheck projects
([evidence/tsrs-parity-20261025](../../evidence/tsrs-parity-20261025/README.md), "Rerun on effect-tsrs 0.2.2"):

- The Effect diagnostics (423, 16 of them gating directive-shaped strings the comment check drops) and the TypeScript
  diagnostics are identical, and three runs per project gave byte-identical output.
- Seeded type errors in five projects: the same 28 errors at the same positions with the same codes.
- Summed over the projects, effect-tsrs took 28.7 s at a 0.6 GB peak, against tsc 53.8 s and effect-tsgo 62.9 s.

## Consequences

- There is no escape hatch while tsrs follows TypeScript 7.1-dev and editors run 7.0.2. A difference between them is
  fixed in code, or reported upstream with a reproduction, or answered by reverting the removal.
- effect-tsrs's CLI changed between minor versions (0.2.2 needs `--type-check`). A future bump reruns the parity method
  before the pin moves.
