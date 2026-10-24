import { drizzle } from 'drizzle-orm/durable-sqlite'
import { DurableScripts } from '../../src/agent-apps/dquickts/runner.ts'
import { NativeEngine, nativeBackend } from '../../src/agent-apps/dquickts/native.ts'
import { CodeStore } from '../../src/agent-apps/dquickts/store.ts'
import { FileStore } from '../../src/files/store.ts'
import { inAgent, type Inside, type Probes } from './probe.ts'
import { TimedIsolates } from './durable-code-baseline.ts'

const filesOf = (inside: Inside) => new FileStore(inside.storage.sql, inside.env.FILES, () => inside.name)
const limits = { wallMs: 30000, calls: 100, fuel: 1000, snapshotBytes: 1048576, steps: 200 }
async function cpu(inside: Inside) {
  const engine = new NativeEngine({
    url: inside.env.DQUICKTS_NATIVE_URL ?? '',
    token: inside.env.DQUICKTS_NATIVE_TOKEN ?? '',
    build: inside.env.DQUICKTS_NATIVE_BUILD ?? '',
    cpuMs: 100,
  })
  const store = new CodeStore(drizzle(inside.storage))
  const runner = new DurableScripts(
    store,
    new TimedIsolates(inside.env.LOADER),
    { ...limits, fuel: 1000000000 },
    engine,
  )
  let calls = 0
  const host = {
    files: filesOf(inside),
    tool: async () => {
      calls += 1
      return null
    },
  }
  const code = "for(let i=0;i<4;i++) tools.call('fixture','tick',{}); while(true){}"
  const result = await runner.run('cpu', code, host)
  const again = await runner.run('cpu', code, host)
  return { result, again, calls, remaining: store.read('cpu')?.checkpoint.cpuRemainingMs }
}
async function blocked(inside: Inside) {
  const samples = []
  const store = new CodeStore(drizzle(inside.storage))
  const native = nativeBackend(inside.env)
  if (native === undefined) throw new Error('native comparison requires native fixture')
  const code = 'let n=0; for(let i=0;i<1000000;i++) n+=i; return n'
  for (const engine of ['wasm', 'native'])
    for (let sample = 0; sample < 5; sample += 1) {
      let last = performance.now()
      let maxTimerDelayMs = 0
      let ticks = 0
      const timer = setInterval(() => {
        const now = performance.now()
        maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last)
        last = now
        ticks += 1
      }, 1)
      const runner = new DurableScripts(
        store,
        new TimedIsolates(inside.env.LOADER),
        limits,
        engine === 'native' ? native : undefined,
      )
      const start = performance.now()
      const result = await runner.run(`${engine}-${String(sample)}`, code, {
        files: filesOf(inside),
        tool: async () => null,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      clearInterval(timer)
      samples.push({ engine, sample, result, elapsedMs: performance.now() - start, maxTimerDelayMs, ticks })
    }
  return { samples }
}
async function unavailable(inside: Inside) {
  const backend = new NativeEngine({
    url: 'http://127.0.0.1:1',
    token: 'local-test-placeholder-no-real-credential',
    build: 'unavailable',
  })
  return new DurableScripts(
    new CodeStore(drizzle(inside.storage)),
    new TimedIsolates(inside.env.LOADER),
    limits,
    backend,
  ).run('unavailable', 'return 42', { files: filesOf(inside), tool: async () => null })
}
export const probes: Probes = {
  'native-code-cpu': inAgent(cpu),
  'native-code-blocked': inAgent(blocked),
  'native-code-down': inAgent(unavailable),
}
