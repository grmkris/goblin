import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import * as Schema from 'effect/Schema'

const Snapshot = Schema.Struct({
  build: Schema.String,
  run: Schema.String,
  base: Schema.String,
  delta: Schema.String,
  mac: Schema.String,
  cpuUsedUs: Schema.Number,
  cpuBudgetMs: Schema.Number,
})
const Frame = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.String),
  snapshot: Schema.optionalKey(Schema.NullOr(Snapshot)),
  cpuMs: Schema.optionalKey(Schema.Number),
  cpuUsedMs: Schema.optionalKey(Schema.Number),
  remainingCpuMs: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  timing: Schema.optionalKey(
    Schema.Struct({
      evalMs: Schema.Number,
      snapshotMs: Schema.Number,
      restoreResumeMs: Schema.Number,
    }),
  ),
})
export type NativeService = Awaited<ReturnType<typeof startNativeService>>

/** The credential is generated for this process, passed on stdin, and never printed or inherited by native children. */
export async function startNativeService() {
  const token = randomBytes(32).toString('hex')
  const child = spawn(
    'python3',
    [
      fileURLToPath(new URL('../../../vendor/dquickts/native-service.py', import.meta.url).href),
      '--binary',
      fileURLToPath(new URL('../../../.local/native/dquickts-native', import.meta.url).href),
      '--test-probes',
    ],
    {
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'pipe',
    },
  )
  child.stderr.on('data', (data) => appendFileSync('../../.local/native/service-errors.log', data))
  child.stdin.end(`${token}\n`)
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // This ChildProcess handle and PID belong to the process spawned above, and it has not exited/reaped.
    if (child.pid === undefined) throw new Error('native fixture has no owned PID')
    child.kill('SIGTERM')
    await exited
  }
  let startup: { readonly port: number; readonly build: string }
  try {
    startup = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timer = setTimeout(
        () => reject(new Error('native fixture startup timeout; build native binary first')),
        5000,
      )
      child.once('error', reject)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('native fixture exited before startup'))
      })
      lines.once('line', (line) => {
        clearTimeout(timer)
        lines.close()
        resolve(
          Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number, build: Schema.String }))(JSON.parse(line)),
        )
      })
    })
  } catch (cause) {
    await stop()
    throw cause
  }
  const url = `http://127.0.0.1:${String(startup.port)}`
  return {
    url,
    token,
    build: startup.build,
    stop,
    call: async (operation: string, payload: Record<string, unknown>, authorized = true) => {
      const response = await fetch(`${url}/${operation}`, {
        method: 'POST',
        headers: { Authorization: authorized ? `Bearer ${token}` : 'Bearer deliberately-wrong-fixture-token' },
        body: JSON.stringify({ build: startup.build, ...payload }),
      })
      return { status: response.status, answer: Schema.decodeUnknownSync(Frame)(await response.json()) }
    },
  }
}
