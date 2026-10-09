# Quality gates

goblin has zero accepted lint, Effect or Knip findings and no baseline. The rule set was adapted from My Apps;
the vendored rules keep their upstream provenance and license under `tools/oxlint/anti-slop/`.

`bun run check` runs format, agent/docs checks, graph, typecheck, the zero-finding lint/Effect/Knip gate, duplication, unit/runtime tests and the production build. Run expensive checks through `heavy` on this box. Never pipe `heavy`; exit 75 means capacity contention. Gate collectors do not nest `heavy` calls.

Oxlint enables correctness/suspicious categories, TypeScript type-aware rules, Oxc, Unicorn, import, a trimmed set of anti-slop rules (SAFETY-commented assertions, no chained or widen-then-assert assertions, no module mocking, no Reflect get/apply, Effect tag rules), runtime/import boundaries, repository configuration/resource-name rules, cognitive complexity, and shadcn rules. Oxfmt owns formatting. Use a consistent nearest `tsconfig.json` for TypeScript and type-aware diagnostics; do not use `oxlint --type-check` as the type gate.

Budgets are 500 code lines/file, 80/function, depth 4, five parameters, and cognitive complexity 15. Tests retain 1000 lines/file with function-length relaxed because the describe block is the file outline. Components own their styling only under `packages/ui/src/components`; shadcn token/color/class checks remain active.

`goblin/no-silent-catch` keeps failures visible. A handler that catches one must pass it on or report it: a `catch` clause, a `.catch(cb)` callback, the handler of `Effect.catch`, `catchCause`, `catchIf`, `orElse` or `orElseSucceed`, and every `Effect.ignore` or `ignoreCause`. It passes when something inside it throws, returns or yields a failure (`Effect.fail`, `failCause`, `die`, `Effect.interrupt`, `yield* new X()`, `Promise.reject`, `reject(...)`) or calls a reporter (`reportFailure`, `reportAndRecover`, any `report*`, `logEvent`, `writeLine`, `failureResponse`); a handler passed by name passes when the name is one of those. Typed handling (`catchTag`, `catchTags`) is not a catch-all and is not checked. When dropping the failure is right, say why on the line above the handler or as its first line: `// expected: <reason of at least ten characters>`.

Fix code before disabling a rule. Every disable names the exact rule and ends in `-- <concrete reason>` of at least ten characters. Effect diagnostic directives follow the same reason convention. Unused disables fail. Prefer Schema decoding, type guards, and fixing types at their source. An unavoidable assertion needs a preceding `// SAFETY:` statement of the invariant TypeScript cannot see. `as const` is exempt.

`tools/graph.ts` declares runtime zones and allowed workspace imports; manifest edges must match. Cloudflare APIs belong to cloud/runtime tests; Bun belongs to tooling; Node/Bun/Cloudflare imports are prohibited in browser and contract code. Runtime settings use Effect Config. Resource names derive from the deployment stage; Alchemy is the sole deployment authority.

Knip checks every issue class; configuration hints are reported but do not fail. jscpd fails above 1.5% duplicate lines, with the reviewed generated/vendor/test exclusions. Effect diagnostics cover every typechecked project; an incomplete tool or unchecked project is a failure. Do not silently record zero findings after parse, resolution, or runtime errors.
