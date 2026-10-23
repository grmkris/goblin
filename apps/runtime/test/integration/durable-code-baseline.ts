import { Isolates } from '../../src/agent-apps/isolates.ts'
import { runScript } from '../../src/agent-apps/script.ts'
import { FileStore } from '../../src/files/store.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'

/** Artificial host delay at the real ScriptFiles boundary; no provider or network. */
export class SlowFiles extends FileStore {
  override async text(path: string, offset: number, limit: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    return super.text(path, offset, limit)
  }
}

export class TimedIsolates extends Isolates {
  occupiedMs = 0
  busy = 0
  override call<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
    return super.call(ms, what, async () => {
      const start = performance.now()
      this.busy += 1
      try {
        return await work()
      } finally {
        this.occupiedMs += performance.now() - start
        this.busy -= 1
      }
    })
  }
}

async function baseline({ storage, env, name }: Inside) {
  const files = new SlowFiles(storage.sql, env.FILES, () => name)
  await files.write('agent', '/agent/slow.txt', 'x', 'text/plain', 1)
  const isolates = new TimedIsolates(env.LOADER)
  const samples = []
  for (let sample = 0; sample < 5; sample += 1) {
    const before = isolates.occupiedMs
    const start = performance.now()
    const result = await runScript(
      isolates,
      files,
      "let n = 0; for (let i = 0; i < 3; i++) n += (await files.read('/agent/slow.txt')).length; return n",
    )
    samples.push({ result, wallMs: performance.now() - start, occupiedMs: isolates.occupiedMs - before })
  }
  return { samples }
}

export const probes: Probes = { 'durable-code-baseline': inAgent(baseline) }
