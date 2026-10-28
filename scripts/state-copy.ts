/**
 * One-off move of a goblin stack's Alchemy state between a local state root and the account's Cloudflare state store
 * (scripts/alchemy-state.ts), record by record, and the proof that both sides hold the same records.
 *
 *   bun scripts/state-copy.ts --stack goblin --stage dev|prod [--to cloudflare|local] [--verify-only]
 *                              [--local-root <dir>]
 *
 * `--to cloudflare` (the default) copies the local root into the store; `--to local` copies the store back into an
 * empty local root (the rollback). `--local-root` names the `state` directory (default `apps/web/.alchemy/state`).
 * Cloudflare credentials come from the mode-600
 * `GOBLIN_CLOUD_ENV_FILE` (default `.local/cloud.env`).
 *
 * It touches only `goblin/{dev,prod}`, refuses a destination that holds any record or
 * output for that stack and stage, and refuses any source record that is not `created` or `updated`. It prints record
 * names with OK or MISMATCH, never a value: records carry secrets. It never uses Alchemy's `syncState`, which deletes
 * every destination stack missing from the source, and the store is shared with myapps.
 */
import { AlchemyContext } from 'alchemy'
import * as Alchemist from 'alchemy/Alchemist'
import { encodeState, type PersistedState, type StateService } from 'alchemy/State'
import { Config, Data, Effect, type Layer, type Scope } from 'effect'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { canonical } from './drift-attributes.ts'

/** The only stacks and stages this script may touch, and the workspace whose `.alchemy/state` is a stack's default. */
const STACKS: Readonly<Record<string, string>> = { goblin: 'apps/web' }
const STAGES: ReadonlyArray<string> = ['dev', 'prod']

export class StateCopyError extends Data.TaggedError('StateCopyError')<{ readonly reason: string }> {}

export interface Target {
  readonly stack: string
  readonly stage: string
}

/** One record (or the stack output) compared by the sha256 of its canonical encoded JSON. */
export interface Comparison {
  readonly name: string
  readonly ok: boolean
}

const refuse = (reason: string) => Effect.fail(new StateCopyError({ reason }))

const allowed = (target: Target) =>
  STACKS[target.stack] !== undefined && STAGES.includes(target.stage)
    ? Effect.succeed(target)
    : refuse(`stack_stage_not_allowed: ${target.stack}/${target.stage}`)

const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonical(encodeState(value)))
    .digest('hex')

const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && digest(a) === digest(b)

/** The output name never collides with a record: FQNs are logical ids joined by `/`. */
export const OUTPUT = '(stack output)'

/** Compare both sides: the same record names, the same encoded records and the same stack output. */
export const verify = Effect.fn('StateCopy.verify')(function* (
  source: StateService,
  destination: StateService,
  target: Target,
) {
  yield* allowed(target)
  const from = new Set(yield* source.list(target))
  const to = new Set(yield* destination.list(target))
  const comparisons: Comparison[] = []
  for (const fqn of [...new Set([...from, ...to])].toSorted()) {
    const ok =
      from.has(fqn) &&
      to.has(fqn) &&
      same(yield* source.get({ ...target, fqn }), yield* destination.get({ ...target, fqn }))
    comparisons.push({ name: fqn, ok })
  }
  comparisons.push({ name: OUTPUT, ok: same(yield* source.getOutput(target), yield* destination.getOutput(target)) })
  return comparisons
})

/** Whether a verification proves equality: at least one record, and every comparison OK. */
export const verified = (comparisons: ReadonlyArray<Comparison>) =>
  comparisons.length > 1 && comparisons.every(({ ok }) => ok)

/**
 * Copy every record, then the stack output, from `source` into an empty `destination`, and verify. Everything is read
 * and checked before the first write.
 */
export const copy = Effect.fn('StateCopy.copy')(function* (
  source: StateService,
  destination: StateService,
  target: Target,
) {
  yield* allowed(target)
  if ((yield* destination.list(target)).length > 0 || (yield* destination.getOutput(target)) !== undefined)
    return yield* refuse(`destination_not_empty: ${target.stack}/${target.stage}`)
  const records: Array<{ readonly fqn: string; readonly value: PersistedState }> = []
  for (const fqn of (yield* source.list(target)).toSorted()) {
    const value = yield* source.get({ ...target, fqn })
    const status = value?.status
    if (value === undefined || (status !== 'created' && status !== 'updated'))
      return yield* refuse(`source_record_not_settled: ${fqn} ${status ?? 'absent'}`)
    records.push({ fqn, value })
  }
  if (records.length === 0) return yield* refuse(`source_has_no_records: ${target.stack}/${target.stage}`)
  const output = yield* source.getOutput(target)
  if (output === undefined) return yield* refuse(`source_has_no_stack_output: ${target.stack}/${target.stage}`)
  for (const { fqn, value } of records) yield* destination.set({ ...target, fqn, value })
  yield* destination.setOutput({ ...target, value: output })
  return yield* verify(source, destination, target)
})

/**
 * A local store rooted at `root`, a directory named `state` (Alchemy keeps `<.alchemy>/state/<stack>/<stage>`). It
 * opens through the CLI's own `Alchemist.State.store({ _tag: 'Local' })`, pointed at `root`'s parent.
 */
export const localStore = (root: string) =>
  Effect.gen(function* () {
    const absolute = resolve(root)
    if (basename(absolute) !== 'state') return yield* refuse('local_root_must_be_a_state_directory')
    return yield* Alchemist.State.store({ _tag: 'Local' }).pipe(
      Effect.provideService(AlchemyContext, {
        dotAlchemy: dirname(absolute),
        dev: false,
        adopt: false,
        updateStateStore: false,
      }),
    )
  })

/** Run `effect` under the services the CLI's state routes need: `Alchemist.layer()`, scoped. */
export const runAlchemist = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof Alchemist.layer>> | Scope.Scope>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Alchemist.layer()), Effect.scoped))

/** Report the refusal, or what failed without its cause: a store error's cause can carry the request. */
const reportFailure = (error: unknown): void => {
  const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : 'error'
  if (error instanceof StateCopyError) console.error(error.reason)
  else if (tag === 'StateStoreError' && typeof error === 'object' && error !== null && 'http' in error)
    console.error(`state_store_error: http ${JSON.stringify(error.http)}`)
  else console.error(`state_copy_failed: ${tag}: ${error instanceof Error ? error.message : 'unknown'}`)
}

const usage =
  'usage: bun scripts/state-copy.ts --stack goblin --stage dev|prod [--to cloudflare|local] ' +
  '[--verify-only] [--local-root <dir>]'

const main = Effect.gen(function* () {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      stack: { type: 'string' },
      stage: { type: 'string' },
      to: { type: 'string', default: 'cloudflare' },
      'verify-only': { type: 'boolean', default: false },
      'local-root': { type: 'string' },
    },
    strict: true,
  })
  const target = yield* allowed({ stack: values.stack ?? '', stage: values.stage ?? '' })
  if (values.to !== 'cloudflare' && values.to !== 'local') return yield* refuse(usage)
  const root = resolve(import.meta.dirname, '..')
  const envFile = yield* Config.String('GOBLIN_CLOUD_ENV_FILE').pipe(
    Config.withDefault(resolve(root, '.local/cloud.env')),
  )
  if ((statSync(envFile).mode & 0o077) !== 0) return yield* refuse('private_cloud_env_requires_mode_600')
  const local = yield* localStore(values['local-root'] ?? resolve(root, STACKS[target.stack] ?? '', '.alchemy/state'))
  // `updateStateStore` stays false (Alchemist.layer()): this never deploys or upgrades the shared store.
  const cloudflare = yield* Alchemist.State.store({ _tag: 'Provider', backend: 'cloudflare', envFile })
  const [source, destination] = values.to === 'cloudflare' ? [local, cloudflare] : [cloudflare, local]
  const comparisons = values['verify-only']
    ? yield* verify(source, destination, target)
    : yield* copy(source, destination, target)
  for (const { name, ok } of comparisons) console.info(`${name} ${ok ? 'OK' : 'MISMATCH'}`)
  const done = verified(comparisons)
  console.info(
    `${target.stack}/${target.stage}: ${values['verify-only'] ? 'compared' : `copied to ${values.to}`}, ` +
      `${done ? 'verified' : 'MISMATCH'} (${comparisons.length - 1} records)`,
  )
  return done
})

if (import.meta.main) {
  const done = await runAlchemist(
    main.pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.sync(() => reportFailure(error)),
          false,
        ),
      ),
    ),
  )
  process.exitCode = done ? 0 : 1
}
