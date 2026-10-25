/**
 * One project's type and Effect pass (ADR 0120), for `bun run typecheck` (tools/typecheck.ts) and the Effect collector
 * of `lint:gate` and `lint:report` (tools/findings.ts): one effect-tsrs run reports the TypeScript diagnostics tsc
 * reports and the Effect diagnostics. Commands run from the repository root without `heavy`: run the whole task through
 * it.
 */
import path from 'node:path'
import { effectArgs, missingPlugin, verifiedEffectOutput } from './effect.ts'
import { decodeEffect, typescriptErrors, uncheckedFiles } from './report.ts'
import type { EffectOutput } from './report.ts'
import { repoRoot, run } from './run.ts'

/** effect-tsrs exits 1 when it reports errors; anything else non-zero means it did not run. */
const FOUND = 1

export interface Pass {
  /** The tsconfig, repository-relative. */
  readonly label: string
  /** Why the pass cannot be trusted: a checker that did not run, or a tsconfig whose files skip the Effect diagnostics. */
  readonly failures: readonly string[]
  /** TypeScript errors as tsc prints them, one entry each. */
  readonly typescript: readonly string[]
  /** The Effect diagnostics, directive-checked; undefined when the checker did not run. */
  readonly effect: EffectOutput | undefined
}

/** The pass over `tsconfig` (repository-relative or absolute). */
export const pass = async (tsconfig: string): Promise<Pass> => {
  const project = path.resolve(repoRoot, tsconfig)
  const label = path.relative(repoRoot, project)
  const missing = missingPlugin(project)
  const before = missing === undefined ? [] : [missing]
  const result = await run(effectArgs(project))
  if (result.exitCode !== 0 && result.exitCode !== FOUND) {
    const failure = `${label}: effect-tsrs exited ${result.exitCode}\n${result.stderr.trim()}`
    return { label, failures: [...before, failure], typescript: [], effect: undefined }
  }
  const effect = verifiedEffectOutput(decodeEffect(JSON.parse(result.stdout)))
  const unchecked = uncheckedFiles(label, effect)
  return {
    label,
    failures: unchecked === undefined ? before : [...before, unchecked],
    typescript: typescriptErrors(effect),
    effect,
  }
}
