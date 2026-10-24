import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Config, ConfigProvider, Effect, Schema } from 'effect'
import { afterAll, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { evict, freshName, nativeFetch, probeOf } from './native-case.ts'
import { until } from './until.ts'
import Stack from './stack.ts'
import { startNativeService, type NativeService } from '../native-service.ts'
import { nativeCases } from './native-code-checks.ts'
mkdirSync('../../.local/durable-code', { recursive: true })
const engine = await Effect.runPromise(Config.String('GOBLIN_DQUICKTS_ENGINE').pipe(Config.withDefault('wasm')))
let service: NativeService | undefined
afterAll(async () => service?.stop())

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: `test_durable_code_${process.pid}`,
  dev: true,
})
const stack = harness.beforeAll(
  Effect.gen(function* () {
    const port = yield* Config.Port('GOBLIN_HARNESS_PORT')
    if (engine === 'native') service = yield* Effect.promise(startNativeService)
    return yield* harness.deploy(Stack).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            GOBLIN_HARNESS_PORT: port + 80,
            GOBLIN_DQUICKTS: 'spike',
            GOBLIN_DQUICKTS_ENGINE: engine,
            GOBLIN_NATIVE_URL: service?.url ?? '',
            GOBLIN_NATIVE_TOKEN: service?.token ?? '',
            GOBLIN_NATIVE_BUILD: service?.build ?? '',
          }).pipe(ConfigProvider.orElse(ConfigProvider.fromEnv())),
        ),
      ),
    )
  }),
)

harness.test(
  'dquickts: local workerd measurements with three slow host calls',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-measure', Schema.Unknown))
    expect(result).toMatchObject({ samples: Array.from({ length: 5 }, () => ({ result: { ok: true, value: 3 } })) })
    writeFileSync(`../../.local/durable-code/${engine}-after.json`, JSON.stringify(result, null, 2))
  }),
)

harness.test(
  'dquickts: actual Pi code_run uses the flagged backend',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-pi', Schema.Unknown))
    expect(result).toMatchObject({
      text: 'once',
      checkpoints: { n: 1 },
      result: { text: expect.stringContaining('42') },
    })
  }),
)

harness.test(
  'dquickts: checkpoint recovery versus read-only replay measurement',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-compare', Schema.Unknown))
    expect(result).toMatchObject({
      samples: Array.from({ length: 5 }, () => ({
        restored: { ok: true, value: 3 },
        replayed: { ok: true, value: 3 },
      })),
    })
    writeFileSync(`../../.local/durable-code/${engine}-replay.json`, JSON.stringify(result, null, 2))
  }),
)

harness.test(
  'dquickts: a suspended host call releases the eight-slot sandbox budget',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-slot', Schema.Unknown))
    expect(result).toMatchObject({
      started: 8,
      ninth: 9,
      suspendedBusy: 0,
      results: Array.from({ length: 8 }, () => ({ ok: true, value: 7 })),
    })
  }),
)

harness.test(
  'dquickts: Pi tool recovery resumes a checkpoint after agent eviction',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(async () => {
      const name = freshName('durable-pi-recovery')
      const first = await probeOf(url, 'durable-code-pi-start', Schema.Struct({ instance: Schema.String }), name)
      const state = Schema.Struct({ row: Schema.NullOr(Schema.String) })
      await until(
        () => probeOf(url, 'durable-code-pi-state', state, name),
        (answer) => {
          if (answer.row === null) return false
          const checkpoint = JSON.parse(answer.row)
          return checkpoint.sequence >= 3 && checkpoint.result === undefined
        },
      )
      await evict(url, name)
      const after = await probeOf(
        url,
        'durable-code-pi-recovered',
        Schema.Struct({ instance: Schema.String, effects: Schema.String, result: Schema.Unknown }),
        name,
      )
      expect(after.instance).not.toBe(first.instance)
      expect(after.effects).toBe('x')
      expect(after.result).toMatchObject({ text: expect.stringContaining('42') })
    })
  }),
)

harness.test(
  'dquickts: eviction resumes the heap without rerunning the completed side effect',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(async () => {
      const name = freshName('durable-recovery')
      const started = nativeFetch(`${url}/probe/durable-code-start?name=${name}`).then(
        () => undefined,
        () => undefined,
      )
      const State = Schema.Struct({
        instance: Schema.String,
        row: Schema.NullOr(
          Schema.Struct({
            checkpoint: Schema.Struct({ call: Schema.optionalKey(Schema.Struct({ callName: Schema.String })) }),
          }),
        ),
      })
      const first = await until(
        () => probeOf(url, 'durable-code-state', State, name),
        (value) => value.row?.checkpoint.call?.callName === 'files.read',
      )
      await evict(url, name)
      await started
      const Recovered = Schema.Struct({
        instance: Schema.String,
        effects: Schema.String,
        result: Schema.Unknown,
        recoveryMs: Schema.Number,
      })
      const after = await probeOf(url, 'durable-code-resume', Recovered, name)
      expect(after.instance).not.toBe(first.instance)
      expect(after.effects).toBe('x')
      expect(after.result).toMatchObject({ ok: true, value: { count: 42, label: 'kept', text: 'restored' } })
      writeFileSync(`../../.local/durable-code/${engine}-recovery.json`, JSON.stringify(after, null, 2))
    })
  }),
)

harness.test(
  'dquickts: native SQLite journal, integrity/build guards and cumulative limits',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-safety', Schema.Unknown))
    expect(result).toMatchObject({
      unknown: { ok: false, error: expect.stringContaining('indeterminate host call') },
      tampered: { ok: false, error: expect.stringContaining('integrity') },
      rejected: { ok: false, error: expect.stringContaining('another source or engine build') },
      limit: { ok: false, error: expect.stringContaining('host call limit') },
      effects: 4,
    })
  }),
)

harness.test(
  'baseline: slow ScriptFiles calls in the unmodified Dynamic Worker backend',
  Effect.gen(function* () {
    const { url } = yield* stack
    const result = yield* Effect.promise(() => probeOf(url, 'durable-code-baseline', Schema.Unknown))
    expect(result).toMatchObject({ samples: Array.from({ length: 5 }, () => ({ result: { ok: true, value: 3 } })) })
    writeFileSync('../../.local/durable-code/baseline.json', JSON.stringify(result, null, 2))
  }),
)

if (engine === 'native')
  for (const check of nativeCases)
    harness.test(
      `native dquickts: ${check.title}`,
      Effect.gen(function* () {
        const { url } = yield* stack
        const owned = service
        if (owned === undefined) throw new Error('native fixture missing')
        yield* Effect.promise(() => check.run(owned, url))
      }),
    )
