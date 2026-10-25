/**
 * The collectors of `bun run lint:report` and `bun run lint:gate`: every finding of oxlint (type-aware), of the Effect
 * diagnostics of every typecheck project (tools/pass.ts), and of knip as configured and in production mode, together
 * with the reasons a collection is incomplete. Each tool runs from the repository root, through `heavy` when it is
 * installed (tools/run.ts). The Effect diagnostics that gate are errors, warnings and directives that change nothing
 * (`gatingDiagnostics` in report.ts).
 */
import { Schema } from 'effect'
import path from 'node:path'
import { effectProjects } from './effect.ts'
import type { Project } from './effect.ts'
import { pass } from './pass.ts'
import { fromEffect, fromKnip, fromOxlint, safeFixCodes } from './report.ts'
import type { Finding, Source } from './report.ts'
import { bin, repoRoot, run } from './run.ts'
import type { RunResult } from './run.ts'

export const SOURCES: readonly Source[] = ['oxlint', 'effect', 'knip']

/** The oxlint config the gates lint with. */
export const OXLINT_CONFIG = path.join(repoRoot, 'oxlint.config.ts')

export interface Collected {
  readonly findings: readonly Finding[]
  /** Why `findings` is incomplete: a tool that did not run, or a project whose files went unchecked. */
  readonly failures: readonly string[]
}

const NOTHING: Collected = { findings: [], failures: [] }

/** Each tool exits 1 when it reports findings; any other non-zero exit means it did not run. */
const didNotRun = (label: string, result: RunResult): readonly string[] =>
  result.exitCode > 1 ? [`${label} exited ${result.exitCode}\n${result.stderr.trim()}`] : []

// ---------------------------------------------------------------------------------------------------------------------
// oxlint

const ConfigModule = Schema.Struct({
  default: Schema.Struct({
    jsPlugins: Schema.optional(
      Schema.NullOr(
        Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String, specifier: Schema.String })])),
      ),
    ),
  }),
})
const decodeConfig = Schema.decodeUnknownSync(ConfigModule)
/** A `jsPlugins` entry that is a bare path or package name (the other form is `{ name, specifier }`). */
const isPath = Schema.is(Schema.String)

const PluginModule = Schema.Struct({
  default: Schema.Struct({
    meta: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
    rules: Schema.Record(
      Schema.String,
      Schema.Struct({ meta: Schema.optional(Schema.Struct({ fixable: Schema.optional(Schema.String) })) }),
    ),
  }),
})
const decodePlugin = Schema.decodeUnknownSync(PluginModule)

/** Rule codes of the config's JS plugins whose rules declare a fix. Plugin paths are relative to the config file. */
const pluginFixCodes = async (config: string): Promise<Set<string>> => {
  const codes = new Set<string>()
  for (const entry of decodeConfig(await import(config)).default.jsPlugins ?? []) {
    const specifier = isPath(entry) ? entry : entry.specifier
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(config), specifier) : specifier
    const plugin = decodePlugin(await import(resolved)).default
    const name = isPath(entry) ? (plugin.meta?.name ?? specifier) : entry.name
    for (const [rule, definition] of Object.entries(plugin.rules)) {
      if (definition.meta?.fixable !== undefined) codes.add(`${name}(${rule})`)
    }
  }
  return codes
}

/**
 * Why an oxlint run cannot be trusted: it did not run, or it wrote to stderr. A JS plugin that fails to load or a
 * type-aware pass that cannot check a file says so on stderr and still exits 0 or 1, so stderr fails the gate too.
 */
export const oxlintFailures = (lint: RunResult): readonly string[] => {
  const failures = didNotRun('oxlint', lint)
  if (failures.length > 0) return failures
  const stderr = lint.stderr.trim()
  return stderr === '' ? [] : [`oxlint wrote to stderr\n${stderr}`]
}

/** The whole repository, type-aware, with `config`. */
export const oxlintFindings = async (config: string): Promise<Collected> => {
  const rules = await run([bin('oxlint'), '--rules', '-f', 'json'])
  if (rules.exitCode !== 0)
    return { findings: [], failures: [`oxlint --rules exited ${rules.exitCode}: ${rules.stderr}`] }
  const fixCodes = new Set([...safeFixCodes(JSON.parse(rules.stdout)), ...(await pluginFixCodes(config))])
  const lint = await run([bin('oxlint'), '-c', config, '-f', 'json', '.'])
  const failures = oxlintFailures(lint)
  if (failures.length > 0) return { findings: [], failures }
  return { findings: fromOxlint(JSON.parse(lint.stdout), (code) => fixCodes.has(code)), failures: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Effect diagnostics

/** Projects checked at the same time. Each is a full type check: effect-tsrs holds at most about 0.6 GB on one thread. */
const EFFECT_CONCURRENCY = 4

/**
 * One project's Effect findings. effect-tsrs reports the project's TypeScript errors in the same run; a project with any
 * fails the collection, since its Effect diagnostics are incomplete.
 */
const effectProject = async ({ dir, tsconfig }: Project): Promise<Collected> => {
  const result = await pass(path.join(dir, tsconfig))
  const typescript =
    result.typescript.length === 0
      ? []
      : [`${result.label}: ${result.typescript.length} TypeScript errors (\`bun run typecheck\` lists them)`]
  return {
    findings: result.effect === undefined ? [] : fromEffect(result.effect),
    failures: [...result.failures, ...typescript],
  }
}

/** `fn` over `items`, at most `limit` at a time; the results keep the order of `items`. */
const mapLimit = async <A, B>(items: readonly A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> => {
  const pending = items.entries()
  const results = new Map<number, B>()
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) results.set(index, await fn(item))
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return [...results].toSorted(([a], [b]) => a - b).map(([, result]) => result)
}

export const effectFindings = async (): Promise<Collected> => {
  const results = await mapLimit(effectProjects(), EFFECT_CONCURRENCY, effectProject)
  const seen = new Map<string, Finding>()
  for (const finding of results.flatMap((result) => result.findings)) {
    seen.set(`${finding.file}:${finding.line}:${finding.rule}`, finding)
  }
  return { findings: [...seen.values()], failures: results.flatMap((result) => result.failures) }
}

// ---------------------------------------------------------------------------------------------------------------------
// knip

/**
 * Why a knip run fails beyond its issues. knip exits 1 for issues and, with `treatConfigHintsAsErrors` in knip.jsonc,
 * for configuration hints too, which its JSON report leaves out: a run that exits 1 with no issue had hints. Turning
 * that flag on is the switch; until then hints are printed by `bun run knip` and do not fail. `label` names the run.
 */
export const knipFailures = (result: RunResult, issues: number, label = 'knip'): readonly string[] => {
  const failures = didNotRun(label, result)
  if (failures.length > 0) return failures
  return result.exitCode === 1 && issues === 0
    ? [`${label} reported configuration hints, which knip.jsonc treats as errors; \`bun run ${label}\` lists them`]
    : []
}

/** One knip run: as configured, or with `production` in production mode (only what knip.jsonc marks with `!`). */
const knipRun = async (production: boolean): Promise<Collected> => {
  const label = production ? 'knip --production' : 'knip'
  const result = await run([
    bin('knip'),
    '--reporter',
    'json',
    '--no-progress',
    ...(production ? ['--production'] : []),
  ])
  const failures = didNotRun(label, result)
  if (failures.length > 0) return { findings: [], failures }
  const findings = fromKnip(JSON.parse(result.stdout), production)
  return { findings, failures: knipFailures(result, findings.length, label) }
}

/** A knip finding's issue, whichever run reported it: its file, line and issue type. */
const knipIssue = (finding: Finding): string =>
  `${finding.file}:${finding.line}:${finding.rule.replace('production:', '')}`

/**
 * knip as configured, then in production mode, which reports what only tests use (an unused file, export or
 * dependency once the tests are left out). An issue the configured run already reports is not counted twice.
 */
export const knipFindings = async (): Promise<Collected> => {
  const configured = await knipRun(false)
  const production = await knipRun(true)
  const known = new Set(configured.findings.map(knipIssue))
  return {
    findings: [...configured.findings, ...production.findings.filter((finding) => !known.has(knipIssue(finding)))],
    failures: [...configured.failures, ...production.failures],
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** The findings of `sources`, one tool after another (oxlint with `config`). */
export const collect = async (sources: readonly Source[], config: string = OXLINT_CONFIG): Promise<Collected> => {
  const parts = [
    sources.includes('oxlint') ? await oxlintFindings(config) : NOTHING,
    sources.includes('effect') ? await effectFindings() : NOTHING,
    sources.includes('knip') ? await knipFindings() : NOTHING,
  ]
  return { findings: parts.flatMap((part) => part.findings), failures: parts.flatMap((part) => part.failures) }
}
