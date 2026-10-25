# goblin quality tooling

This workspace owns checks, diagnostics collectors, the runtime/import graph, docs checks and custom AST plugins. The
vendored anti-slop rules stay byte-identical to upstream (see `tools/oxlint/anti-slop/PROVENANCE.md`).

Run `bun run typecheck` (TypeScript and Effect diagnostics in one effect-tsrs pass per project, ADR 0120) and focused
Vitest tests. Root checks call tools by explicit path. Tool failures and unchecked projects fail gates; never translate
them into zero findings. There is no lint baseline.
