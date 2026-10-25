# ADR 0120: Type and Effect diagnostics run on tsrs

Status: Accepted 2026-10-25 (owner, from the research wrap-up of 2026-10-24). Changes how `bun run typecheck` and the
Effect gate run; no runtime change.

## Context

`bun run check` type-checked every project twice. `typecheck` ran tsc (TypeScript 7.0.2, the Go compiler) on each
tsconfig, and `lint:gate` then ran effect-tsgo, the Effect language service on the same Go compiler, on each tsconfig
again for the Effect diagnostics. On this repository's largest project, `apps/runtime`, tsc took 16 s at 1.8 GB and
effect-tsgo 22 s at 2.0 GB, one after the other.

tsrs (oxc-project/tsrs) is a Rust port of the TypeScript 7 compiler. `@yielded/effect-tsrs` (MIT) runs all of Effect's
language-service diagnostics on it, reads the same `@effect/language-service` block of the tsconfig, and its JSON
carries the program's TypeScript diagnostics beside the Effect ones.

## Decision

**One effect-tsrs pass per project replaces tsc and effect-tsgo.** `bun run typecheck` runs `tools/typecheck.ts` on
the root tsconfig and, through turbo, on every tsconfig a workspace's `typecheck` script names. Each runs
`effect-tsrs diagnostics` once (`tools/pass.ts`) and fails on a TypeScript error, on an Effect diagnostic that gates
(errors, warnings and directives that change nothing, as before), or when the checker fails. A workspace whose
`typecheck` does not run `tools/typecheck.ts` fails the tools tests and `lint:gate`, so no project leaves the Effect
diagnostics.

**`check` runs the pass once.** It runs `typecheck`, then `lint:gate --skip effect`. `lint:gate` alone and
`lint:report` still collect the Effect findings with the same pass. `check:fast` gains the Effect diagnostics for free.

**Coverage is read from the tsconfig.** effect-tsgo counted the files it checked without the plugin; effect-tsrs does
not. Each project's tsconfig must set or inherit the `@effect/language-service` block, followed through `extends` as
TypeScript merges it (a child's `plugins` replaces its parent's), before the pass runs.

**The native binary runs directly.** `tools/effect.ts` resolves the static executable of the platform package, as the
package's Node launcher does, so no Node is needed in CI and no launcher process runs.

**Pins are exact.** `@yielded/effect-tsrs` 0.2.0, which bundles its own tsrs (rev 8f135f1, TypeScript 7.1-dev). It is
the only new dependency: the gate never runs the standalone `tsrs` package, so it is not installed.

**`EFFECT_CHECKER=tsgo` falls back** to the pair it replaced, tsc then effect-tsgo, for about two weeks (until
2026-11-08). Turbo hashes the variable, so a cached result of one checker never stands for the other. Removing the
fallback later is a follow-up; `@effect/tsgo` stays for editors either way.

**What stays:** editors use `@effect/tsgo`, and type-aware lint stays on oxlint with oxlint-tsgolint. effect-tsrs's
Oxlint integration would save nothing while the other type-aware rules still run on Go.

## Evidence

Parity on 2026-10-25, every one of the 12 typecheck projects, sequentially on the build box
([evidence/tsrs-parity-20261025](../../evidence/tsrs-parity-20261025/README.md)):

- The Effect diagnostics are identical, as `(file, line, code, severity)` sets over each project's own files: 419
  diagnostics, 16 that gate (directive-shaped strings in tool tests, which the comment check drops), none differing.
- The TypeScript diagnostics are identical: none on the tree, and the same 28 errors at the same positions with the
  same codes when type errors were seeded into five projects.
- Three effect-tsrs runs per project gave byte-identical output.
- Summed over the projects, tsc and effect-tsgo took 54 s and 60 s, peaking at 1.8 and 2.0 GB; effect-tsrs took 28 s
  for both, peaking at 0.6 GB.
- On the same box, `typecheck` and `lint:gate` as `check` runs them went from 186 s to 87 s.

## Consequences

- effect-tsrs, like tsc, checks every source file of a program, so a file imported across workspaces gets its Effect
  diagnostics in each program that imports it; effect-tsgo reported only a project's own files. Findings dedupe by file,
  line and rule. On 2026-10-25 no gating diagnostic fell outside a file's own project.
- tsrs follows TypeScript 7.1-dev while editors and the fallback run 7.0.2. A difference between them shows as a gate
  difference; the fallback is the escape hatch while effect-tsrs is new.
- effect-tsrs runs each pass on one thread whatever the tsconfig says (it has no thread option; Swarmm's tsconfig,
  without `singleThreaded`, showed the same), so turbo's concurrency is what runs projects side by side.

## Rejected

- **Keeping tsc beside effect-tsrs.** Parity was exact on every project, so a second compiler run buys nothing.
- **effect-tsrs's Oxlint integration.** The other type-aware rules would still run on oxlint-tsgolint.
