import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { DurableScripts } from '../../src/agent-apps/dquickts/runner.ts'
import { CodeStore, checkpointDigest } from '../../src/agent-apps/dquickts/store.ts'
import { FileStore } from '../../src/files/store.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { SlowFiles, TimedIsolates } from './durable-code-baseline.ts'
import { ownerSend } from './probe-reads.ts'
import { until } from './until.ts'
import { runScript } from '../../src/agent-apps/script.ts'
import { nativeBackend } from '../../src/agent-apps/dquickts/native.ts'

const recoveryCode =
  "const state = {count:40,label:'kept'}; state.count += tools.call('fixture','effect',{}); const text = files.read('/agent/wait.txt'); return {...state,text}"
const filesOf = ({ storage, env, name }: Inside) => new FileStore(storage.sql, env.FILES, () => name)
const runnerOf = (inside: Inside, slots = new TimedIsolates(inside.env.LOADER)) =>
  new DurableScripts(new CodeStore(drizzle(inside.storage)), slots, undefined, nativeBackend(inside.env))
const toolOf = (files: FileStore) => async () => {
  const prior = (await files.text('/agent/effects.txt', 0, 100)).text
  await files.write('agent', '/agent/effects.txt', `${prior}x`, 'text/plain', prior.length + 1)
  return 2
}

class WaitingFiles extends FileStore {
  override async text(path: string, offset: number, limit: number) {
    if (path === '/agent/wait.txt') await new Promise<void>((resolve) => setTimeout(resolve, 5000))
    return super.text(path, offset, limit)
  }
}

async function beginRecovery(inside: Inside) {
  const files = filesOf(inside)
  await files.write('agent', '/agent/effects.txt', '', 'text/plain', 0)
  await files.write('agent', '/agent/wait.txt', 'restored', 'text/plain', 8)
  return runnerOf(inside).run('recovery', recoveryCode, {
    files: new WaitingFiles(inside.storage.sql, inside.env.FILES, () => inside.name),
    tool: toolOf(files),
  })
}

async function resume(inside: Inside) {
  const files = filesOf(inside)
  const start = performance.now()
  const result = await runnerOf(inside).run('recovery', recoveryCode, { files, tool: toolOf(files) })
  return {
    result,
    instance: inside.agent.instance,
    effects: (await files.text('/agent/effects.txt', 0, 100)).text,
    recoveryMs: performance.now() - start,
  }
}

async function measure(inside: Inside) {
  const slots = new TimedIsolates(inside.env.LOADER)
  const runner = runnerOf(inside, slots)
  const files = new SlowFiles(inside.storage.sql, inside.env.FILES, () => inside.name)
  await files.write('agent', '/agent/slow.txt', 'x', 'text/plain', 1)
  const samples = []
  for (let sample = 0; sample < 5; sample += 1) {
    const before = slots.occupiedMs
    const start = performance.now()
    const result = await runner.run(
      `measure-${String(sample)}`,
      "let n = 0; for (let i = 0; i < 3; i++) n += files.read('/agent/slow.txt').length; return n",
      { files, tool: async () => null },
    )
    samples.push({ result, wallMs: performance.now() - start, occupiedMs: slots.occupiedMs - before })
  }
  return { samples }
}

/** Same three-read program: restore at the third read versus rerun all three read-only calls. */
async function compareRecovery(inside: Inside) {
  const samples = []
  const files = new SlowFiles(inside.storage.sql, inside.env.FILES, () => inside.name)
  await files.write('agent', '/agent/slow.txt', 'x', 'text/plain', 1)
  const code = "let n = 0; for (let i = 0; i < 3; i++) n += files.read('/agent/slow.txt').length; return n"
  for (let sample = 0; sample < 5; sample += 1) {
    let arrived!: () => void
    let finish!: () => void
    const boundary = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    class GateFiles extends SlowFiles {
      #reads = 0
      override async text(path: string, offset: number, limit: number) {
        this.#reads += 1
        if (this.#reads === 3) {
          arrived()
          await held
        }
        return super.text(path, offset, limit)
      }
    }
    const id = `compare-${String(sample)}`
    const pending = runnerOf(inside).run(id, code, {
      files: new GateFiles(inside.storage.sql, inside.env.FILES, () => inside.name),
      tool: async () => null,
    })
    await Promise.race([pending, boundary])
    const restoreStart = performance.now()
    const restored = await runnerOf(inside).run(id, code, { files, tool: async () => null })
    const restoreMs = performance.now() - restoreStart
    const replayStart = performance.now()
    const replayed = await runScript(
      new TimedIsolates(inside.env.LOADER),
      files,
      code.replace("files.read('/agent/slow.txt').length", "(await files.read('/agent/slow.txt')).length"),
    )
    const replayMs = performance.now() - replayStart
    finish()
    await pending
    samples.push({ restored, replayed, restoreMs, replayMs })
  }
  return { samples }
}

async function slot(inside: Inside) {
  const slots = new TimedIsolates(inside.env.LOADER)
  const runner = runnerOf(inside, slots)
  const files = filesOf(inside)
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  let started = 0
  const promises = Array.from({ length: 8 }, (_, i) =>
    runner.run(`slot-${String(i)}`, "const answer = tools.call('fixture','slow',{}); return answer", {
      files,
      tool: async () => {
        started += 1
        await waiting
        return 7
      },
    }),
  )
  await until(
    async () => started,
    (count) => count === 8,
  )
  const suspendedBusy = slots.busy
  let ninth: number
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    ninth = await Promise.race([
      slots.call(1000, 'ninth sandbox', async () => 9),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('suspended runs held all slots')), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
    finish()
  }
  const results = await Promise.all(promises)
  return { started, ninth, suspendedBusy, results }
}

async function pi(inside: Inside) {
  await ownerSend(
    inside.api,
    PRIMARY_CHAT,
    `call code_run ${JSON.stringify({ code: "const n: number = 40; files.write('/agent/pi-durable.txt', 'once'); return n + 2" })}`,
    'durable-pi',
  )
  const result = await inside.agent.settle(PRIMARY_CHAT, 'durable-pi')
  return {
    result,
    text: (await filesOf(inside).text('/agent/pi-durable.txt', 0, 100)).text,
    checkpoints: inside.storage.sql.exec('SELECT count(*) AS n FROM app_code_runs').one(),
  }
}

async function piStart(inside: Inside) {
  const files = filesOf(inside)
  await files.write('agent', '/agent/pi-effects.txt', '', 'text/plain', 0)
  const code =
    "files.write('/agent/pi-effects.txt', files.read('/agent/pi-effects.txt') + 'x'); const state = {n:40,label:'kept'}; for(let i=0;i<60;i++) files.read('/agent/pi-effects.txt'); return {...state,n:state.n+2}"
  await ownerSend(inside.api, PRIMARY_CHAT, `call code_run ${JSON.stringify({ code })}`, 'durable-pi-recovery')
  return { instance: inside.agent.instance }
}

async function piRecovered(inside: Inside) {
  const result = await inside.agent.settle(PRIMARY_CHAT, 'durable-pi-recovery')
  return {
    result,
    instance: inside.agent.instance,
    effects: (await filesOf(inside).text('/agent/pi-effects.txt', 0, 100)).text,
  }
}

async function safety(inside: Inside) {
  const store = new CodeStore(drizzle(inside.storage))
  const slots = new TimedIsolates(inside.env.LOADER)
  const files = filesOf(inside)
  let effects = 0
  const pendingRuns: Promise<unknown>[] = []
  const finishes: (() => void)[] = []
  const code = "return tools.call('fixture','effect',{})"
  const suspend = async (id: string) => {
    let entered!: () => void
    const signal = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<number>((resolve) => {
      finishes.push(() => resolve(2))
    })
    const pending = runnerOf(inside, slots).run(id, code, {
      files,
      tool: async () => {
        effects += 1
        entered()
        return held
      },
    })
    await Promise.race([pending, signal])
    pendingRuns.push(pending)
  }
  const host = {
    files,
    tool: async () => {
      effects += 1
      return 2
    },
  }
  await suspend('unknown')
  const unknown = await runnerOf(inside, slots).run('unknown', code, host)
  await suspend('tampered')
  inside.storage.sql.exec("UPDATE app_code_runs SET delta = 'AAAA' WHERE id = 'tampered'")
  const tampered = await runnerOf(inside, slots).run('tampered', code, host)
  await suspend('foreign')
  const foreign = store.read('foreign')
  if (foreign === undefined) throw new Error('checkpoint missing')
  const changed = { ...foreign, checkpoint: { ...foreign.checkpoint, build: 'foreign-engine' } }
  inside.storage.sql.exec(
    'UPDATE app_code_runs SET checkpoint = ?, digest = ? WHERE id = ?',
    JSON.stringify(changed.checkpoint),
    await checkpointDigest(changed),
    'foreign',
  )
  const rejected = await runnerOf(inside, slots).run('foreign', code, host)
  const limited = new DurableScripts(
    store,
    slots,
    {
      wallMs: 30000,
      calls: 1,
      fuel: 1000,
      snapshotBytes: 1048576,
      steps: 200,
    },
    nativeBackend(inside.env),
  )
  const limit = await limited.run(
    'limit',
    "tools.call('fixture','read',{}); return tools.call('fixture','read',{})",
    host,
  )
  const answer = { unknown, tampered, rejected, limit, effects }
  for (const finish of finishes) finish()
  await Promise.all(pendingRuns)
  return answer
}

export const probes: Probes = {
  'durable-code-start': inAgent(beginRecovery),
  'durable-code-state': inAgent((inside) => ({
    instance: inside.agent.instance,
    row: new CodeStore(drizzle(inside.storage)).read('recovery') ?? null,
  })),
  'durable-code-resume': inAgent(resume),
  'durable-code-measure': inAgent(measure),
  'durable-code-compare': inAgent(compareRecovery),
  'durable-code-slot': inAgent(slot),
  'durable-code-pi': inAgent(pi),
  'durable-code-pi-start': inAgent(piStart),
  'durable-code-pi-state': inAgent((inside) => ({
    row:
      inside.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM app_code_runs LIMIT 1').toArray()[0]
        ?.checkpoint ?? null,
  })),
  'durable-code-pi-recovered': inAgent(piRecovered),
  'durable-code-safety': inAgent(safety),
}
