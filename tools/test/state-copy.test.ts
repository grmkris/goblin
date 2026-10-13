import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copy, localStore, OUTPUT, runAlchemist, verified, verify } from '../../scripts/state-copy.ts'

const DEV = { stack: 'goblin', stage: 'dev' }

/** A settled resource record as Alchemy persists it; `attr` stands in for the provider attributes. */
const record = (fqn: string, status: 'created' | 'updated', attr: Record<string, unknown>) => ({
  resourceType: 'Cloudflare.R2.Bucket',
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: `instance-${fqn}`,
  providerVersion: 1,
  status,
  downstream: [],
  bindings: [],
  props: { name: `goblin-dev-${fqn.toLowerCase()}` },
  attr,
})

let directory = ''
const roots = () => ({ source: join(directory, 'box/state'), destination: join(directory, 'store/state') })

/** Both stores, with `source` seeded by `seed` first. */
const stores = <A>(seed: (source: Effect.Success<ReturnType<typeof localStore>>) => Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    const source = yield* localStore(roots().source)
    const destination = yield* localStore(roots().destination)
    yield* seed(source)
    return { source, destination }
  })

const deployed = stores((source) =>
  Effect.gen(function* () {
    yield* source.set({ ...DEV, fqn: 'Files', value: record('Files', 'created', { bucketName: 'goblin-dev-files' }) })
    yield* source.set({ ...DEV, fqn: 'Web', value: record('Web', 'updated', { url: 'https://dev.goblin.example' }) })
    yield* source.setOutput({ ...DEV, value: { url: 'https://dev.goblin.example', authDatabase: 'db-1' } })
  }),
)

const reason = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.flip(effect).pipe(Effect.map((error) => (error instanceof Error && 'reason' in error ? error.reason : error)))

describe('state-copy between two local stores', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'goblin-state-copy-test-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('copies every record and the stack output, then verifies them by name', async () => {
    const comparisons = await runAlchemist(
      Effect.gen(function* () {
        const { source, destination } = yield* deployed
        return yield* copy(source, destination, DEV)
      }),
    )
    expect(comparisons).toEqual([
      { name: 'Files', ok: true },
      { name: 'Web', ok: true },
      { name: OUTPUT, ok: true },
    ])
    expect(verified(comparisons)).toBe(true)
    expect(readdirSync(join(roots().destination, 'goblin/dev')).toSorted()).toEqual([
      'Files.json',
      'Web.json',
      '__stack_output__.json',
    ])
  })

  it('refuses a destination that already holds a record, and writes nothing', async () => {
    const outcome = await runAlchemist(
      Effect.gen(function* () {
        const { source, destination } = yield* deployed
        yield* destination.set({ ...DEV, fqn: 'Web', value: record('Web', 'created', { url: 'https://other' }) })
        const refused = yield* reason(copy(source, destination, DEV))
        return { refused, left: yield* destination.list(DEV), output: yield* destination.getOutput(DEV) }
      }),
    )
    expect(outcome).toEqual({ refused: 'destination_not_empty: goblin/dev', left: ['Web'], output: undefined })
  })

  it('refuses an unsettled source record or a stack outside the allowlist before writing', async () => {
    const outcome = await runAlchemist(
      Effect.gen(function* () {
        const { source, destination } = yield* deployed
        yield* source.set({
          ...DEV,
          fqn: 'goblinAuth',
          value: { ...record('goblinAuth', 'created', {}), status: 'creating' as const },
        })
        const unsettled = yield* reason(copy(source, destination, DEV))
        const foreign = yield* reason(copy(source, destination, { stack: 'myapps', stage: 'dev' }))
        return { unsettled, foreign, written: yield* destination.list(DEV) }
      }),
    )
    expect(outcome).toEqual({
      unsettled: 'source_record_not_settled: goblinAuth creating',
      foreign: 'stack_stage_not_allowed: myapps/dev',
      written: [],
    })
  })

  it('verify-only compares without writing: an empty destination does not verify', async () => {
    const outcome = await runAlchemist(
      Effect.gen(function* () {
        const { source, destination } = yield* deployed
        const comparisons = yield* verify(source, destination, DEV)
        return { comparisons, written: yield* destination.list(DEV) }
      }),
    )
    expect(outcome.written).toEqual([])
    expect(outcome.comparisons).toEqual([
      { name: 'Files', ok: false },
      { name: 'Web', ok: false },
      { name: OUTPUT, ok: false },
    ])
    expect(verified(outcome.comparisons)).toBe(false)
  })

  it('reports a changed record and a changed output as MISMATCH, by name only', async () => {
    const comparisons = await runAlchemist(
      Effect.gen(function* () {
        const { source, destination } = yield* deployed
        yield* copy(source, destination, DEV)
        yield* destination.set({ ...DEV, fqn: 'Files', value: record('Files', 'created', { bucketName: 'changed' }) })
        yield* destination.setOutput({ ...DEV, value: { url: 'https://dev.goblin.example', authDatabase: 'db-2' } })
        return yield* verify(source, destination, DEV)
      }),
    )
    expect(comparisons).toEqual([
      { name: 'Files', ok: false },
      { name: 'Web', ok: true },
      { name: OUTPUT, ok: false },
    ])
    expect(verified(comparisons)).toBe(false)
  })
})
