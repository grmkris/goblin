import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Isolates } from '../src/agent-apps/isolates.ts'
import { DurableScripts } from '../src/agent-apps/dquickts/runner.ts'
import { CodeStore } from '../src/agent-apps/dquickts/store.ts'
import type { FileStore } from '../src/files/store.ts'
import { fake } from './fake.ts'
import { durable } from './chats-sqlite.ts'
import { BREAK } from '../src/storage/migrations/migration.ts'
import { MIGRATIONS } from '../src/storage/migrations.ts'
import { appCodeRuns } from '../src/storage/durable-code.ts'
import { Dquickts } from '../src/agent-apps/dquickts/abi.ts'
import { durableSource } from '../src/agent-apps/dquickts/source.ts'
import type { CodeHost } from '../src/agent-apps/dquickts/host.ts'
import type { CodeLimits } from '../src/agent-apps/dquickts/runner.ts'

const databases: DatabaseSync[] = []
mkdirSync('../../.local/durable-code', { recursive: true })
// Node compiles test fixtures; Worker ambient types intentionally omit compilation APIs.
const compileWasm: (bytes: Uint8Array) => Promise<WebAssembly.Module> = runInNewContext('WebAssembly.compile')
const setup = async () => {
  const sqlite = new DatabaseSync(':memory:')
  databases.push(sqlite)
  for (const migration of MIGRATIONS) for (const statement of migration.sql.split(BREAK)) sqlite.exec(statement)
  const db = drizzle({ client: sqlite })
  const store = new CodeStore(durable(db))
  const module = await compileWasm(
    readFileSync(fileURLToPath(new URL('../src/agent-apps/dquickts/engine.wasm', import.meta.url).href)),
  )
  const runner = (limits?: CodeLimits) => new DurableScripts(store, new Isolates(undefined), limits, module)
  return { sqlite, db, store, module, runner }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const defaults = { wallMs: 30000, calls: 100, fuel: 1000, snapshotBytes: 1048576, steps: 200 }
const host = (tool: CodeHost['tool'] = async () => 2): CodeHost => ({ files: fake<FileStore>({}), tool })
const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('dquickts durable code adapter', () => {
  it('suspends at a host call, restores a fresh instance and keeps state', async () => {
    const { sqlite, runner, store } = await setup()
    const files = fake<FileStore>({})
    const calls: string[] = []
    const result = await runner().run(
      'run-1',
      "const state = {count: 40}; const answer = tools.call('fixture', 'lookup', {key:'abc'}); state.count += answer.value; return state",
      {
        files,
        tool: async (input) => {
          calls.push(input.name)
          return { value: 2 }
        },
      },
    )
    expect(result).toMatchObject({ ok: true, value: { count: 42 } })
    expect(calls).toEqual(['lookup'])
    const hash = createHash('sha256')
      .update(readFileSync(fileURLToPath(new URL('../src/agent-apps/dquickts/engine.wasm', import.meta.url).href)))
      .digest('hex')
    expect(store.read('run-1')?.checkpoint.build).toBe(`${hash}:host-v1`)
    expect(sqlite.prepare('SELECT count(*) AS n FROM app_code_runs').get()).toEqual({ n: 1 })
  })

  it('never reexecutes a completed side effect, including a completed entire run', async () => {
    const { runner } = await setup()
    let calls = 0
    const tool = host(async () => {
      calls += 1
      return calls
    })
    const code = "return tools.call('fixture','write',{})"
    expect(await runner().run('once', code, tool)).toMatchObject({ ok: true, value: 1 })
    expect(await runner().run('once', code, tool)).toMatchObject({ ok: true, value: 1 })
    expect(calls).toBe(1)
  })

  it('keeps a fuel reservation across a crash before the next heap checkpoint', async () => {
    const { store, module, runner } = await setup()
    const entered = signal()
    const finish = signal()
    class PausedSlots extends Isolates {
      #slices = 0
      override async call<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
        this.#slices += 1
        const result = await super.call(ms, what, work)
        if (this.#slices === 2) {
          entered.resolve()
          await finish.promise
        }
        return result
      }
    }
    let calls = 0
    const code = "return tools.call('fixture','write',{})"
    const first = new DurableScripts(store, new PausedSlots(undefined), undefined, module).run(
      'commit-gap',
      code,
      host(async () => {
        calls += 1
        return 42
      }),
    )
    await Promise.race([first, entered.promise])
    expect(store.read('commit-gap')?.checkpoint.fuel).toBeLessThan(defaults.fuel)
    expect(
      await runner().run(
        'commit-gap',
        code,
        host(async () => {
          calls += 1
          return 42
        }),
      ),
    ).toMatchObject({ ok: true, value: 42 })
    expect(calls).toBe(1)
    finish.resolve()
    await first
  })

  it('marks an unrecorded side effect indeterminate after reconstruction', async () => {
    const { runner } = await setup()
    const entered = signal()
    const finish = signal()
    let calls = 0
    const first = runner().run(
      'unknown',
      "return tools.call('fixture','write',{})",
      host(async () => {
        calls += 1
        entered.resolve()
        await finish.promise
        return null
      }),
    )
    await Promise.race([first, entered.promise])
    const recovered = await runner().run(
      'unknown',
      "return tools.call('fixture','write',{})",
      host(async () => {
        calls += 1
        return null
      }),
    )
    expect(recovered).toMatchObject({ ok: false, error: expect.stringContaining('indeterminate host call unknown:0') })
    expect(calls).toBe(1)
    finish.resolve()
    await first
  })

  it('retries a known local read after reconstruction and retains closure state', async () => {
    const { runner } = await setup()
    const entered = signal()
    const finish = signal()
    let reads = 0
    const code = "const n = 40; return n + files.read('/agent/input').length"
    const first = runner().run('read', code, {
      ...host(),
      files: fake<FileStore>({
        text: async () => {
          reads += 1
          entered.resolve()
          await finish.promise
          return { entry: fake({}), text: 'xx' }
        },
      }),
    })
    await Promise.race([first, entered.promise])
    const recovered = await runner().run('read', code, {
      ...host(),
      files: fake<FileStore>({
        text: async () => {
          reads += 1
          return { entry: fake({}), text: 'xx' }
        },
      }),
    })
    expect(recovered).toMatchObject({ ok: true, value: 42 })
    expect(reads).toBe(2)
    finish.resolve()
    await first
  })

  it.each(['delta', 'build', 'source', 'result'])(
    'rejects changed %s before reading native snapshots or returning a result',
    async (field) => {
      const { runner, store, db } = await setup()
      const entered = signal()
      const finish = signal()
      const code = "return tools.call('fixture','wait',{})"
      const first = runner().run(
        'tamper',
        code,
        host(async () => {
          entered.resolve()
          await finish.promise
          return null
        }),
      )
      await Promise.race([first, entered.promise])
      const row = store.read('tamper')
      expect(row).toBeDefined()
      if (row === undefined) throw new Error('missing checkpoint')
      const set =
        field === 'delta'
          ? { delta: `${row.delta.slice(0, 20)}AAAA` }
          : {
              checkpoint: {
                ...row.checkpoint,
                ...(field === 'build'
                  ? { build: 'foreign' }
                  : field === 'source'
                    ? { codeHash: 'foreign' }
                    : { result: { ok: true, value: 'forged', logs: [] } }),
              },
            }
      db.update(appCodeRuns).set(set).where(eq(appCodeRuns.id, 'tamper')).run()
      expect(await runner().run('tamper', code, host())).toMatchObject({
        ok: false,
        error: expect.stringMatching(/integrity|another source or engine build/u),
      })
      finish.resolve()
      await first
    },
  )

  it.each([
    ['calls', { calls: 1 }, "tools.call('f','a',{}); return tools.call('f','b',{})", /host call limit/u],
    ['fuel', { fuel: 5 }, 'while(true){}', /interrupted|instruction limit/u],
    ['snapshot', { snapshotBytes: 10 }, "return tools.call('f','a',{})", /snapshot byte limit/u],
    ['wall', { wallMs: 0 }, "return tools.call('f','a',{})", /wall limit/u],
  ] as const)('enforces the cumulative %s budget', async (_name, limits, code, error) => {
    const { runner } = await setup()
    expect(await runner({ ...defaults, ...limits }).run('limit', code, host())).toMatchObject({
      ok: false,
      error: expect.stringMatching(error),
    })
  })

  it('bounds a stalled host call by the original wall deadline', async () => {
    const { runner } = await setup()
    let invoked = false
    const result = await runner({ ...defaults, wallMs: 1000 }).run(
      'stalled',
      "return tools.call('f','write',{})",
      host(async () => {
        invoked = true
        return new Promise(() => undefined)
      }),
    )
    expect(invoked).toBe(true)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/indeterminate.*wall limit/u) })
  })

  it('preserves the instruction budget through multiple compute checkpoints', async () => {
    const { runner, store } = await setup()
    const result = await runner({ ...defaults, fuel: 60 }).run(
      'compute',
      'let n=0; while(n<100000000) n++; return n',
      host(),
    )
    expect(result.ok).toBe(false)
    expect(store.read('compute')?.checkpoint.steps).toBeGreaterThan(1)
  })

  it('enforces engine memory and output limits and exposes no network or timers', async () => {
    const { runner } = await setup()
    expect(
      await runner().run('globals', 'return [typeof fetch, typeof process, typeof setTimeout]', host()),
    ).toMatchObject({ ok: true, value: ['undefined', 'undefined', 'undefined'] })
    expect(await runner().run('memory', 'return new ArrayBuffer(16 * 1024 * 1024)', host())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/out of memory/u),
    })
    expect(await runner().run('output', "return 'x'.repeat(300000)", host())).toMatchObject({
      ok: false,
      error: expect.stringContaining('output limit'),
    })
  })

  it('measures snapshot sizes and fresh-instance restore+resume (Node, not billing)', async () => {
    const { module } = await setup()
    const samples = []
    for (let i = 0; i < 9; i += 1) {
      const vm = new Dquickts(module)
      vm.init()
      const base = vm.snapshot(1)
      vm.budget(1000)
      expect(
        vm.eval(durableSource("const state = {n:40}; state.n += tools.call('fixture','lookup',{}); return state")),
      ).toBe(1)
      const delta = vm.snapshot(2)
      vm.dispose()
      const fresh = new Dquickts(module)
      const start = performance.now()
      fresh.restore(base, delta)
      fresh.budget(1000)
      expect(fresh.resume({ ok: true, value: 2 })).toBe(0)
      const restoreResumeMs = performance.now() - start
      expect(JSON.parse(fresh.output())).toMatchObject({ value: { n: 42 } })
      fresh.dispose()
      samples.push({ baseBytes: base.byteLength, deltaBytes: delta.byteLength, restoreResumeMs })
    }
    writeFileSync('../../.local/durable-code/snapshot.json', JSON.stringify({ samples }, null, 2))
  })
})
