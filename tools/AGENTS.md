# Purrable quality tooling

This workspace owns checks, diagnostics collectors, the runtime/import graph, and custom AST plugins. Keep `tools/quality-provenance.json` and `tools/myapps-source-inventory.json` with source adaptations; vendored anti-slop source stays byte-identical and retains every license.

Run `bun run typecheck`, `bun run effect:check`, and focused Vitest tests. Root checks call tools by explicit path. Tool failures and unchecked projects fail gates; never translate them into zero findings. Purrable accepts no lint baseline. Do not weaken copied rule families to clear a gate.
