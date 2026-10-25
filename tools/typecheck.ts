/**
 * `typecheck`: the TypeScript and Effect diagnostics of the given tsconfigs, in one pass per project (ADR 0120).
 *
 *   bun ../../tools/typecheck.ts tsconfig.json scripts/tsconfig.json     from a workspace's `typecheck` script
 *   bun tools/typecheck.ts --workspaces tsconfig.json                    `bun run typecheck`: the root tsconfig, then
 *                                                                        every workspace through turbo
 *
 * Each project runs once through effect-tsrs (tools/pass.ts), which reports what tsc reports and the Effect diagnostics
 * configured in the `@effect/language-service` block of tsconfig.base.json (docs/agents/lint-quality.md).
 * `EFFECT_CHECKER=tsgo` runs tsc and then effect-tsgo instead, the pair effect-tsrs replaced. The check fails on a
 * TypeScript error, on an Effect diagnostic that gates (`gatingDiagnostics` in report.ts: errors, warnings and
 * directives that change nothing), when a tsconfig neither sets nor inherits the plugin block (its files would go
 * unchecked), or when a checker fails. Tsconfig paths are relative to the current directory. This script does not use
 * `heavy`; run the whole task through it (`heavy bun run typecheck`).
 */
import path from 'node:path'
import { checker } from './effect.ts'
import { pass } from './pass.ts'
import { gatingDiagnostics } from './report.ts'
import { bin, run } from './run.ts'

const using = checker()

/** Checks one tsconfig and prints its TypeScript errors and the Effect diagnostics that gate. Returns whether it passed. */
const check = async (tsconfig: string): Promise<boolean> => {
  const result = await pass(path.resolve(tsconfig), using, true)
  for (const error of result.typescript) console.log(error)
  const found = result.effect === undefined ? [] : gatingDiagnostics(result.effect)
  for (const diagnostic of found)
    console.log(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} effect(${diagnostic.name}): ${diagnostic.message}`,
    )
  for (const failure of result.failures) console.error(failure)
  console.log(
    `${result.label}: ${result.typescript.length} TypeScript errors, ${found.length} Effect findings in ` +
      `${result.effect?.summary.filesChecked ?? 0} files (effect-${using})`,
  )
  return result.typescript.length === 0 && found.length === 0 && result.failures.length === 0
}

/** Every workspace's typecheck, at turbo's concurrency; all of them run even when one fails. */
const workspaces = async (): Promise<boolean> => {
  const argv = [bin('turbo'), 'run', 'typecheck', '--continue']
  console.log(`$ ${argv.join(' ')}`)
  return (await run(argv, { inherit: true })).exitCode === 0
}

const args = Bun.argv.slice(2)
const tsconfigs = args.filter((arg) => arg !== '--workspaces')
if (tsconfigs.length === 0) {
  console.error('usage: bun tools/typecheck.ts [--workspaces] <tsconfig>...')
  process.exit(2)
}
let passed = true
for (const tsconfig of tsconfigs) passed = (await check(tsconfig)) && passed
if (args.includes('--workspaces')) passed = (await workspaces()) && passed
process.exit(passed ? 0 : 1)
