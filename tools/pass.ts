/**
 * One project's type and Effect pass (ADR 0120), for `bun run typecheck` (tools/typecheck.ts) and the Effect collector
 * of `lint:gate` and `lint:report` (tools/findings.ts). With effect-tsrs, the default, one run reports the TypeScript
 * diagnostics tsc reports and the Effect diagnostics. With `EFFECT_CHECKER=tsgo`, the fallback, tsc reports the first and
 * effect-tsgo the second, as before effect-tsrs. Commands run from the repository root without `heavy`: run the whole
 * task through it.
 */
import path from 'node:path'
import { effectArgs, missingPlugin, verifiedEffectOutput } from './effect.ts'
import type { Checker } from './effect.ts'
import { decodeEffect, typescriptErrors, uncheckedFiles } from './report.ts'
import type { EffectOutput } from './report.ts'
import { bin, repoRoot, run } from './run.ts'

/** effect-tsrs and effect-tsgo exit 1 when they report errors; anything else non-zero means they did not run. */
const FOUND = 1

export interface Pass {
  /** The tsconfig, repository-relative. */
  readonly label: string
  /** Why the pass cannot be trusted: a checker that did not run, or a tsconfig whose files skip the Effect diagnostics. */
  readonly failures: readonly string[]
  /** TypeScript errors as tsc prints them, one entry each. With tsgo, only when the pass ran tsc. */
  readonly typescript: readonly string[]
  /** The Effect diagnostics, directive-checked; undefined when the checker did not run. */
  readonly effect: EffectOutput | undefined
}

/** tsc's errors on one project: its output, one entry per diagnostic (an indented line continues the one above). */
const tsc = async (project: string, label: string): Promise<{ errors: string[]; failures: string[] }> => {
  const result = await run([bin('tsc'), '-p', project, '--pretty', 'false'])
  const errors: string[] = []
  for (const line of result.stdout.split('\n').filter((text) => text.trim() !== '')) {
    if (/^\s/u.test(line) && errors.length > 0) errors[errors.length - 1] += `\n${line}`
    else errors.push(line)
  }
  return result.exitCode !== 0 && errors.length === 0
    ? { errors, failures: [`${label}: tsc exited ${result.exitCode}\n${result.stderr.trim()}`] }
    : { errors, failures: [] }
}

/**
 * The pass over `tsconfig` (repository-relative or absolute) with `using`. With tsgo, `typescript` also runs tsc first;
 * effect-tsrs reports the TypeScript diagnostics whether they are wanted or not.
 */
export const pass = async (tsconfig: string, using: Checker, typescript: boolean): Promise<Pass> => {
  const project = path.resolve(repoRoot, tsconfig)
  const label = path.relative(repoRoot, project)
  const missing = missingPlugin(project)
  const types = using === 'tsgo' && typescript ? await tsc(project, label) : { errors: [], failures: [] }
  const before = [...(missing === undefined ? [] : [missing]), ...types.failures]
  const result = await run(effectArgs(project, using))
  if (result.exitCode !== 0 && result.exitCode !== FOUND) {
    const failure = `${label}: effect-${using} exited ${result.exitCode}\n${result.stderr.trim()}`
    return { label, failures: [...before, failure], typescript: types.errors, effect: undefined }
  }
  const effect = verifiedEffectOutput(decodeEffect(JSON.parse(result.stdout)))
  const unchecked = uncheckedFiles(label, effect)
  return {
    label,
    failures: unchecked === undefined ? before : [...before, unchecked],
    typescript: using === 'tsrs' ? typescriptErrors(effect) : types.errors,
    effect,
  }
}
