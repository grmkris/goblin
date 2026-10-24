import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../../env.ts'
import type { CodeCheckpoint } from '../../storage/durable-code.ts'
import { ScriptResult } from '../script-result.ts'
import { decodeSnapshot, encodeSnapshot, type CallResponse, type CodeRow } from './store.ts'
import { durableSource } from './source.ts'

const Snapshot = Schema.Struct({
  build: Schema.String,
  run: Schema.String,
  base: Schema.String,
  delta: Schema.String,
  mac: Schema.String,
  cpuUsedUs: Schema.Number,
  cpuBudgetMs: Schema.Number,
})
const Answer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
  fuel: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.String),
  snapshot: Schema.optionalKey(Schema.NullOr(Snapshot)),
  cpuMs: Schema.optionalKey(Schema.Number),
  remainingCpuMs: Schema.optionalKey(Schema.Number),
})
const Pending = Schema.Struct({ callName: Schema.String, args: Schema.Unknown })
type Resume = { readonly row: CodeRow; readonly response: CallResponse }

/** Local-only HTTP hop. Snapshot MACs and native build checks are independently enforced by the controller. */
export class NativeEngine {
  readonly build: string
  readonly cpuBudgetMs: number
  readonly #url: string
  readonly #token: string
  readonly #serverBuild: string
  constructor(options: {
    readonly url: string
    readonly token: string
    readonly build: string
    readonly cpuMs?: number
  }) {
    this.#url = options.url
    this.#token = options.token
    this.#serverBuild = options.build
    this.build = `native:${options.build}:host-v1`
    this.cpuBudgetMs = options.cpuMs ?? 1000
  }
  /** Reserve a bounded slice before dispatch; a lost response forfeits only this slice, never refills CPU. */
  reservation(checkpoint: CodeCheckpoint): number {
    return Math.min(checkpoint.cpuRemainingMs ?? this.cpuBudgetMs, 200)
  }

  async #post(operation: string, payload: Record<string, unknown>) {
    const url = new URL(this.#url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '')
      throw new Error('native service requires a loopback HTTP URL')
    if (this.#token.length < 32 || this.#serverBuild === '') throw new Error('native service configuration missing')
    let response: Response
    try {
      response = await fetch(new URL(`/${operation}`, url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, build: this.#serverBuild }),
        redirect: 'manual',
        signal: AbortSignal.timeout(5500),
      })
    } catch (cause) {
      throw new Error('native service unavailable', { cause })
    }
    const answer = Schema.decodeUnknownSync(Answer)(await response.json())
    if (!response.ok || !answer.ok) throw new Error(answer.error ?? 'native service rejected slice')
    if (answer.build !== this.#serverBuild) throw new Error('native service returned a foreign build')
    return answer
  }
  async advance(id: string, checkpoint: CodeCheckpoint, code?: string, resume?: Resume) {
    const snapshot =
      resume === undefined
        ? undefined
        : Schema.decodeUnknownSync(Snapshot)(JSON.parse(new TextDecoder().decode(decodeSnapshot(resume.row.base))))
    const answer = await this.#post(resume === undefined ? 'eval' : 'resume', {
      run: id,
      cpuBudgetMs: this.cpuBudgetMs,
      remainingCpuMs: Math.max(1, this.reservation(checkpoint) - 20),
      fuel: checkpoint.fuel,
      wallMs: Math.max(1, Math.min(2000, checkpoint.expiresAt - Date.now())),
      snapshot,
      input: resume === undefined ? durableSource(code ?? '') : JSON.stringify(resume.response),
    })
    if (answer.status === undefined || answer.output === undefined || answer.fuel === undefined)
      throw new Error('native service returned an incomplete slice')
    const common = {
      ...checkpoint,
      fuel: answer.fuel,
      steps: checkpoint.steps + 1,
      sequence: checkpoint.sequence + (resume === undefined ? 0 : 1),
      cpuRemainingMs: Math.max(0, (checkpoint.cpuRemainingMs ?? 0) - (answer.cpuMs ?? this.reservation(checkpoint))),
    }
    if (answer.status <= 0)
      return {
        checkpoint: {
          ...common,
          result:
            answer.status < 0
              ? { ok: false, error: answer.output, logs: [] }
              : Schema.decodeUnknownSync(ScriptResult)(JSON.parse(answer.output)),
        },
        base: '',
        delta: '',
      }
    if (answer.snapshot === undefined || answer.snapshot === null) throw new Error('native snapshot missing')
    return {
      checkpoint: { ...common, call: Schema.decodeUnknownSync(Pending)(JSON.parse(answer.output)) },
      base: encodeSnapshot(new TextEncoder().encode(JSON.stringify(answer.snapshot))),
      delta: '',
    }
  }
}

export const nativeBackend = (
  env: Pick<RuntimeEnv, 'DQUICKTS_ENGINE' | 'DQUICKTS_NATIVE_URL' | 'DQUICKTS_NATIVE_TOKEN' | 'DQUICKTS_NATIVE_BUILD'>,
) =>
  env.DQUICKTS_ENGINE === 'native'
    ? new NativeEngine({
        url: env.DQUICKTS_NATIVE_URL ?? '',
        token: env.DQUICKTS_NATIVE_TOKEN ?? '',
        build: env.DQUICKTS_NATIVE_BUILD ?? '',
      })
    : undefined
