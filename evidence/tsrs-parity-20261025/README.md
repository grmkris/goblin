# tsrs parity, 2026-10-25 (ADR 0120)

Before `bun run typecheck` moved onto effect-tsrs, every project the gates cover ran under the old pair (tsc 7.0.2 and
effect-tsgo 0.54.0, `@effect/tsgo`) and under `@yielded/effect-tsrs` 0.2.0 (bundled tsrs rev 8f135f1, TypeScript
7.1-dev), on goblin `dev` at e2e2d4b4 with the new dependency installed.

## Method

- `parity.py <repo> <outdir> 3 <tsconfig>...` runs, per project and one command at a time from the repository root:
  `tsc -p <tsconfig> --pretty false`, `effect-tsgo diagnostics --project <tsconfig> --format json`, `effect-tsrs
  diagnostics -p <tsconfig> --format json` three times, and once more with `--rules none` (the compiler alone).
- `measure.py` runs each command in a fresh Python process and records its wall time and peak RSS
  (`resource.getrusage(RUSAGE_CHILDREN)`), so every number is that command's own.
- Effect diagnostics compare as `(file, line, code, severity)` sets over the project's own files (`tsc --showConfig`
  lists them; effect-tsgo reports only those, effect-tsrs every source file of the program). The gating subset is
  errors, warnings and code 377000. TypeScript diagnostics compare as `(file, line, code)` sets: tsc's text against
  effect-tsrs's `typescriptDiagnostics`. Determinism compares the three runs' sorted JSON byte for byte.
- `seeded.py` copies the files in `seeds/` into four projects (type errors under `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, missing `lib` and `types`, JSX props, React
  state, an unused `@ts-expect-error`, Effect and Schema types), runs tsc and effect-tsrs on them, compares the errors'
  positions, codes and first message lines, and removes the files.
- The parity run went through `heavy` on the build box (16 EPYC cores, no other heavy job in its slot), sequentially.

## Results

| Project | Own files | tsc | effect-tsgo | effect-tsrs, 3 runs | `--rules none` | Effect diagnostics / gating | Effect equal | TS equal (errors) | Deterministic |
| :-- | --: | --: | --: | --: | --: | --: | :-- | :-- | :-- |
| `tsconfig.json` | 69 | 5.94 s, 879 MB | 7.9 s, 887 MB | 2.9 / 3.16 / 2.75 s, 331 MB | 2.0 s | 17 / 8 | yes | yes (3) | yes |
| `apps/cli/tsconfig.json` | 22 | 0.85 s, 176 MB | 1.58 s, 190 MB | 0.72 / 0.41 / 0.49 s, 74 MB | 0.3 s | 9 / 0 | yes | yes (0) | yes |
| `apps/openui-spike/tsconfig.json` | 7 | 3.83 s, 891 MB | 3.7 s, 752 MB | 1.85 / 1.34 / 1.44 s, 339 MB | 1.58 s | 0 / 0 | yes | yes (0) | yes |
| `apps/runtime/tsconfig.json` | 773 | 15.91 s, 1788 MB | 21.99 s, 2008 MB | 9.67 / 10.09 / 9.57 s, 599 MB | 5.64 s | 212 / 0 | yes | yes (0) | yes |
| `apps/web/tsconfig.json` | 455 | 16.85 s, 1667 MB | 11.89 s, 1216 MB | 8.08 / 8.75 / 8.14 s, 519 MB | 6.35 s | 17 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.json` | 13 | 0.24 s, 80 MB | 1.01 s, 190 MB | 0.16 / 0.21 / 0.2 s, 53 MB | 0.17 s | 0 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.ui.json` | 9 | 2.12 s, 329 MB | 1.84 s, 215 MB | 0.89 / 0.82 / 0.87 s, 111 MB | 0.75 s | 0 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.render.json` | 3 | 1.44 s, 187 MB | 1.23 s, 190 MB | 0.55 / 0.58 / 0.72 s, 64 MB | 0.46 s | 0 / 0 | yes | yes (0) | yes |
| `packages/contracts/tsconfig.json` | 85 | 1.74 s, 265 MB | 2.79 s, 290 MB | 1.08 / 1.04 / 0.99 s, 89 MB | 0.68 s | 150 / 0 | yes | yes (0) | yes |
| `packages/kit/tsconfig.json` | 13 | 0.8 s, 194 MB | 1.55 s, 196 MB | 0.39 / 0.45 / 0.32 s, 79 MB | 0.3 s | 0 / 0 | yes | yes (0) | yes |
| `packages/ui/tsconfig.json` | 62 | 1.14 s, 210 MB | 1.97 s, 244 MB | 0.52 / 0.71 / 0.53 s, 77 MB | 0.46 s | 0 / 0 | yes | yes (0) | yes |
| `tools/tsconfig.json` | 44 | 2.83 s, 390 MB | 2.8 s, 379 MB | 1.04 / 1.29 / 1.49 s, 125 MB | 1.28 s | 14 / 8 | yes | yes (0) | yes |
| **Sum / peak** | | **53.7 s, 1788 MB** | **60.3 s, 2008 MB** | **27.9 s, 599 MB** | **20.0 s** | **419 / 16** | | | |

- The 16 gating diagnostics are directive-shaped strings in the tool tests (`tools/test/goblin.test.ts`,
  `tools/test/report.test.ts`), reported by both checkers and dropped by the gate's comment check
  (`verifiedEffectOutput`). Both name the code 377000 differently: effect-tsgo `effect(377000)`, effect-tsrs
  `unusedDirective`.
- The root project's 3 TypeScript errors came from `scripts/fixtures/mcp-app`, whose own dependencies were not installed
  for this run (CI installs them separately). Both checkers reported the same three errors at the same positions.
- effect-tsrs reported 684 Effect diagnostics in all, 265 of them on files outside a project's own (a file imported
  across workspaces, checked again in the importer's program). None of those gates.
- effect-tsrs ran on one thread (user time about equal to wall time); so did tsc, under `singleThreaded: true`.
- Before and after, per `check`: tsc and effect-tsgo summed 114 s of compiler time at up to 2.0 GB; the one effect-tsrs
  pass sums 28 s at up to 0.6 GB.

## Seeded type errors

`seeded.py` (results in `seeded.json`) placed 28 type errors in five projects. tsc and effect-tsrs reported the same
errors at the same positions with the same codes in every project:

| Project | Errors (both) | Codes |
| :-- | --: | :-- |
| `tools/tsconfig.json` | 6 | 1294 (`erasableSyntaxOnly`), 2307, 2322, 2375 (`exactOptionalPropertyTypes`) |
| `apps/runtime/tsconfig.json` | 9 | 1484 (`verbatimModuleSyntax`), 2322, 2375, 2578 (unused `@ts-expect-error`), 2584 (no DOM lib), 2693, 2868 (no Bun types), 7006 |
| `apps/web/tsconfig.json` | 4 | 2322 (JSX prop), 2339, 2345 (React state) |
| `packages/contracts/tsconfig.json` | 4 | 2322 (Schema and Effect types) |
| `tsconfig.json` | 5 | 2307, 2322, 2375 |

One message differs in text only: where a long type is elided, tsc prints `options: { ...; } | BufferEncoding` and
effect-tsrs `options: ... | BufferEncoding` (the same TS2322 at the same position).

## Gate timings

The same build box, one `heavy` slot, sequentially, turbo forced (`TURBO_FORCE=1`, `TURBO_CONCURRENCY=4`): the old tree
(`dev` at 20e928c7) against this change on top of it.

| Step | Before | After |
| :-- | --: | --: |
| `bun run typecheck` | 74.6 s, 1.8 GB (tsc) | 39.2 s, 0.6 GB (TypeScript and Effect) |
| `bun run lint:gate` in `check` | 111.7 s, 3.6 GB (oxlint, effect-tsgo, knip) | 47.8 s, 3.9 GB (`--skip effect`: oxlint, knip) |
| **Both, as `check` runs them** | **186.3 s** | **87.0 s** |
| `bun run lint:gate` alone (Effect included, 4 projects at a time) | 111.7 s | 60.2 s |
| `EFFECT_CHECKER=tsgo bun run typecheck` (fallback: tsc, then effect-tsgo) | | 114.8 s, 2.1 GB |
| `EFFECT_CHECKER=tsgo bun run lint:gate` (fallback) | | 156.1 s |

The peak of `lint:gate` is oxlint's type-aware pass (oxlint-tsgolint), which this change leaves alone.

`parity.json` holds every number and set difference (all empty). Rerun with
`python3 -I evidence/tsrs-parity-20261025/parity.py "$PWD" <outdir> 3 <tsconfig>...` from the repository root, through
`heavy`.

## Rerun on effect-tsrs 0.2.2 (ADR 0121)

Before the pin moved from 0.2.0 to 0.2.2 (still tsrs rev 8f135f1), the same method ran again on every project, on goblin
`dev` at 6ea77818 (tsc 7.0.2, effect-tsgo 0.54.0). 0.2.2 reports the TypeScript diagnostics only with `--type-check`, so
`parity.py` ran it through a two-line wrapper that appends that flag (`EFFECT_TSRS=<wrapper>`); `seeded.py` takes the
same override now. Results: `parity-0.2.2.json`, `seeded-0.2.2.json`.

| Project | Own files | tsc | effect-tsgo | effect-tsrs 0.2.2, 3 runs | Effect diagnostics / gating | Effect equal | TS equal (errors) | Deterministic |
| :-- | --: | --: | --: | --: | --: | :-- | :-- | :-- |
| `tsconfig.json` | 70 | 5.99 s, 936 MB | 6.38 s, 982 MB | 2.59 / 2.07 / 2.07 s, 362 MB | 19 / 8 | yes | yes (0) | yes |
| `apps/cli/tsconfig.json` | 22 | 0.84 s, 181 MB | 1.66 s, 190 MB | 0.37 / 0.36 / 0.33 s, 74 MB | 9 / 0 | yes | yes (0) | yes |
| `apps/openui-spike/tsconfig.json` | 7 | 5.27 s, 884 MB | 4.28 s, 752 MB | 2.01 / 1.91 / 1.59 s, 339 MB | 0 / 0 | yes | yes (0) | yes |
| `apps/runtime/tsconfig.json` | 773 | 15.37 s, 1881 MB | 25.83 s, 2020 MB | 11.51 / 12.21 / 12.37 s, 607 MB | 212 / 0 | yes | yes (0) | yes |
| `apps/web/tsconfig.json` | 459 | 16.81 s, 1675 MB | 11.77 s, 1220 MB | 8.68 / 7.89 / 7.17 s, 517 MB | 17 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.json` | 13 | 0.3 s, 81 MB | 1.03 s, 190 MB | 0.12 / 0.13 / 0.14 s, 39 MB | 0 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.ui.json` | 9 | 1.44 s, 304 MB | 1.37 s, 215 MB | 0.55 / 0.54 / 0.67 s, 111 MB | 0 / 0 | yes | yes (0) | yes |
| `packages/app/tsconfig.render.json` | 3 | 1.16 s, 190 MB | 1.14 s, 190 MB | 0.35 / 0.33 / 0.37 s, 64 MB | 0 / 0 | yes | yes (0) | yes |
| `packages/contracts/tsconfig.json` | 85 | 2.01 s, 274 MB | 2.9 s, 301 MB | 0.78 / 0.67 / 0.81 s, 89 MB | 150 / 0 | yes | yes (0) | yes |
| `packages/kit/tsconfig.json` | 13 | 0.7 s, 191 MB | 1.42 s, 204 MB | 0.32 / 0.39 / 0.29 s, 80 MB | 0 / 0 | yes | yes (0) | yes |
| `packages/ui/tsconfig.json` | 62 | 1.05 s, 216 MB | 1.81 s, 234 MB | 0.47 / 0.42 / 0.44 s, 77 MB | 0 / 0 | yes | yes (0) | yes |
| `tools/tsconfig.json` | 45 | 2.82 s, 383 MB | 3.28 s, 379 MB | 0.96 / 0.97 / 0.91 s, 123 MB | 16 / 8 | yes | yes (0) | yes |
| **Sum / peak** | | **53.8 s, 1881 MB** | **62.9 s, 2020 MB** | **28.7 s, 607 MB** | **423 / 16** | | | |

- The Effect and TypeScript diagnostics are identical on all 12 projects, and three runs per project gave byte-identical
  output. The seeded run gave the same 28 errors at the same positions with the same codes (one message again differs
  only in how a long type is elided); both checkers exit 1 on them.
- 0.2.2 reports Effect diagnostics only on a project's own files, as effect-tsgo does: 423 in all, where 0.2.0 reported
  684 with the cross-workspace repeats. The own-file count moved only with the tree (419 → 423: two more each in the
  root and tools projects, which effect-tsgo reports too).
- 0.2.2 counts the files it checks without the plugin again (`summary.filesWithoutPlugin`, 0 on every project).
- It honours `singleThreaded: true` from tsconfig.base.json (user time about equal to wall time), so the peak stays
  0.6 GB.
