import * as Schema from 'effect/Schema'
import { sha256Hex } from '../../runtime/digest.ts'
import type { CodeCheckpoint } from '../../storage/durable-code.ts'
import type { Isolates } from '../isolates.ts'
import { ScriptResult } from '../script-result.ts'
import { COMPUTE_QUANTUM, Dquickts } from './abi.ts'
import { codeDeadline, codeReadOnly, dispatchCodeHost, type CodeHost } from './host.ts'
import { durableSource } from './source.ts'
import {
  checkpointDigest,
  CodeStore,
  decodeSnapshot,
  encodeSnapshot,
  type CodeRow,
  type CallResponse,
} from './store.ts'

/** Exact artifact and host registry version. A different build must never read this build's trusted bytes. */
const BUILD = 'e3abf1cd294d57a26e23ee232ccfeed6b2f4b00535b75be2d840b9e1f61bad71:host-v1'
const Pending = Schema.Struct({ callName: Schema.String, args: Schema.Unknown })
const failed = (error: string): ScriptResult => ({ ok: false, error, logs: [] })

export type CodeLimits = {
  readonly wallMs: number
  readonly calls: number
  readonly fuel: number
  readonly snapshotBytes: number
  readonly steps: number
}
const LIMITS: CodeLimits = { wallMs: 30000, calls: 100, fuel: 1000, snapshotBytes: 1048576, steps: 200 }

/**
 * Pi invokes one run id at a time; on tool recovery it invokes the same id. Each boundary stores a delta against the
 * original base, disposes WASM and releases the shared isolate slot before waiting on the host. No script is replayed.
 */
export class DurableScripts {
  readonly #store: CodeStore
  readonly #slots: Isolates
  readonly #limits: CodeLimits
  readonly #module: WebAssembly.Module | undefined
  constructor(store: CodeStore, slots: Isolates, limits = LIMITS, module?: WebAssembly.Module) {
    this.#store = store
    this.#slots = slots
    this.#limits = limits
    this.#module = module
  }

  async run(id: string, code: string, host: CodeHost): Promise<ScriptResult> {
    const module = this.#module ?? (await import('./module.ts')).default
    const hash = await sha256Hex(code)
    let row = this.#store.read(id)
    if (row !== undefined && (row.checkpoint.codeHash !== hash || row.checkpoint.build !== BUILD))
      return failed('snapshot belongs to another source or engine build')
    try {
      if (row !== undefined && (await checkpointDigest(row)) !== row.digest)
        throw new Error('snapshot integrity check failed')
      if (row === undefined)
        row = await this.#store.put(
          id,
          {
            codeHash: hash,
            build: BUILD,
            expiresAt: Date.now() + this.#limits.wallMs,
            fuel: this.#limits.fuel,
            sequence: 0,
            steps: 0,
          },
          '',
          '',
        )
      if (row.base === '' && row.checkpoint.result === undefined)
        row = await this.#advance(module, id, row.checkpoint, code)
      while (row.checkpoint.result === undefined) {
        if ((await checkpointDigest(row)) !== row.digest) throw new Error('snapshot integrity check failed')
        this.#check(row.checkpoint)
        const response = await this.#host(row, host)
        row = await this.#advance(module, id, row.checkpoint, undefined, { row, response })
      }
      return row.checkpoint.result
    } catch (cause) {
      // expected: script failures become a durable code_run result for Pi and the agent to read.
      return this.#failure(id, row, cause)
    }
  }

  async #failure(id: string, previous: CodeRow | undefined, cause: unknown): Promise<ScriptResult> {
    const result = failed(cause instanceof Error ? cause.message : 'durable code failed')
    const row = this.#store.read(id) ?? previous
    if (row !== undefined) await this.#store.put(id, { ...row.checkpoint, result }, row.base, row.delta)
    return result
  }

  #check(checkpoint: CodeCheckpoint): void {
    if (Date.now() >= checkpoint.expiresAt) throw new Error('cumulative script wall limit exceeded')
    if (checkpoint.sequence >= this.#limits.calls) throw new Error('cumulative host call limit exceeded')
    if (checkpoint.steps >= this.#limits.steps || checkpoint.fuel <= 0)
      throw new Error('cumulative instruction limit exceeded')
  }

  async #host(row: CodeRow, host: CodeHost): Promise<CallResponse> {
    const call = row.checkpoint.call
    if (call === undefined) throw new Error('missing durable host call')
    const sequence = row.checkpoint.sequence
    const previous = this.#store.call(row.id, sequence)
    if (previous?.response !== null && previous?.response !== undefined) return previous.response
    if (previous !== undefined && !codeReadOnly(call.callName))
      throw new Error(
        `indeterminate host call ${row.id}:${String(sequence)}; outcome was not durably recorded, never retried`,
      )
    if (previous === undefined) this.#store.intent(row.id, sequence)
    let response: CallResponse
    try {
      response = await codeDeadline(
        dispatchCodeHost(host, call.callName, call.args, `${row.id}:${String(sequence)}`),
        row.checkpoint.expiresAt,
      )
    } catch (cause) {
      if (!codeReadOnly(call.callName))
        throw new Error(
          `indeterminate host call ${row.id}:${String(sequence)}; ${cause instanceof Error ? cause.message : 'host failure'}`,
          { cause },
        )
      response = { ok: false, error: cause instanceof Error ? cause.message : 'host failure' }
    }
    // The journal commits before advancing the VM. A crash here restores the same heap and reuses this response.
    this.#store.complete(row.id, sequence, response)
    return response
  }

  async #advance(
    module: WebAssembly.Module,
    id: string,
    checkpoint: CodeCheckpoint,
    code?: string,
    resume?: { readonly row: CodeRow; readonly response: CallResponse },
  ): Promise<CodeRow> {
    this.#check(checkpoint)
    // Debit the maximum compute quantum before restoring. A crash cannot replenish instruction fuel; successful
    // checkpoints refund the unused reservation by recording the VM's exact remaining budget.
    await this.#store.put(
      id,
      { ...checkpoint, fuel: Math.max(0, checkpoint.fuel - COMPUTE_QUANTUM) },
      resume?.row.base ?? '',
      resume?.row.delta ?? '',
    )
    const stepped = await this.#slots.call(this.#limits.wallMs, 'durable script slice', async () => {
      const vm = new Dquickts(module)
      try {
        let base: string
        if (resume === undefined) {
          vm.init()
          base = encodeSnapshot(vm.snapshot(1))
        } else {
          vm.restore(decodeSnapshot(resume.row.base), decodeSnapshot(resume.row.delta))
          base = resume.row.base
        }
        vm.budget(checkpoint.fuel)
        const status = resume === undefined ? vm.eval(durableSource(code ?? '')) : vm.resume(resume.response)
        const output = vm.output()
        const common = {
          ...checkpoint,
          fuel: vm.remaining(),
          steps: checkpoint.steps + 1,
          sequence: checkpoint.sequence + (resume === undefined ? 0 : 1),
        }
        if (status < 0) return { checkpoint: { ...common, result: failed(output) }, base, delta: '' }
        if (status === 0)
          return {
            checkpoint: { ...common, result: Schema.decodeUnknownSync(ScriptResult)(JSON.parse(output)) },
            base,
            delta: '',
          }
        const call = Schema.decodeUnknownSync(Pending)(JSON.parse(output))
        const delta = vm.snapshot(2)
        if (decodeSnapshot(base).byteLength + delta.byteLength > this.#limits.snapshotBytes)
          throw new Error('snapshot byte limit exceeded')
        return { checkpoint: { ...common, call }, base, delta: encodeSnapshot(delta) }
      } finally {
        vm.dispose()
      }
    })
    if (Date.now() >= checkpoint.expiresAt) throw new Error('cumulative script wall limit exceeded')
    if (stepped.checkpoint.result === undefined) this.#check({ ...stepped.checkpoint, sequence: checkpoint.sequence })
    return this.#store.put(id, stepped.checkpoint, stepped.base, stepped.delta)
  }
}
