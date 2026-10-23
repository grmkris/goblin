/** Maximum interrupt work reserved before executing one compute slice. */
export const COMPUTE_QUANTUM = 20

/** The pinned reactor exports; pointers are offsets into its private WASM memory. */
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  _initialize(): void
  dq_init(): number
  dq_dispose(): void
  dq_eval(ptr: number, len: number): number
  dq_resume(ptr: number, len: number): number
  dq_restore(base: number, baseLen: number, delta: number, deltaLen: number): number
  dq_snapshot(flags: number): number
  dq_snapshot_len(): number
  dq_output(): number
  dq_alloc(len: number): number
  dq_free(ptr: number): void
  dq_budget(fuel: number, quantum: number): void
  dq_remaining(): number
}

/** Filesystem-free WASI host. Scripts get no WASI imports or host objects. */
export class Dquickts {
  readonly #ex: Exports
  constructor(module: WebAssembly.Module) {
    let memory: WebAssembly.Memory
    const instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: {
        clock_time_get: (id: number, _precision: bigint, out: number) => {
          new DataView(memory.buffer).setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true)
          return 0
        },
        random_get: (ptr: number, len: number) => {
          for (let at = 0; at < len; at += 65536)
            crypto.getRandomValues(new Uint8Array(memory.buffer, ptr + at, Math.min(65536, len - at)))
          return 0
        },
        fd_write: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
      },
    })
    // SAFETY: engine.wasm is built by vendor/dquickts/build.sh with exactly this exported C ABI.
    this.#ex = instance.exports as Exports
    memory = this.#ex.memory
    this.#ex._initialize()
  }

  init(): void {
    if (this.#ex.dq_init() < 0) throw new Error(this.output())
  }
  dispose(): void {
    this.#ex.dq_dispose()
  }
  budget(fuel: number): void {
    this.#ex.dq_budget(fuel, COMPUTE_QUANTUM)
  }
  remaining(): number {
    return this.#ex.dq_remaining()
  }
  eval(source: string): number {
    return this.#input(new TextEncoder().encode(source), (p, n) => this.#ex.dq_eval(p, n))
  }
  resume(value: unknown): number {
    return this.#input(new TextEncoder().encode(JSON.stringify(value)), (p, n) => this.#ex.dq_resume(p, n))
  }
  output(): string {
    const bytes = new Uint8Array(this.#ex.memory.buffer)
    const start = this.#ex.dq_output()
    const end = bytes.indexOf(0, start)
    if (end < 0) throw new Error('unterminated dquickts output')
    return new TextDecoder().decode(bytes.subarray(start, end))
  }
  snapshot(flags: number): Uint8Array {
    const ptr = this.#ex.dq_snapshot(flags)
    if (ptr === 0) throw new Error(this.output())
    return new Uint8Array(this.#ex.memory.buffer).slice(ptr, ptr + this.#ex.dq_snapshot_len())
  }
  restore(base: Uint8Array, delta: Uint8Array): void {
    const status = this.#input(base, (bp, bn) => this.#input(delta, (dp, dn) => this.#ex.dq_restore(bp, bn, dp, dn)))
    if (status < 0) throw new Error(this.output())
  }
  #input<T>(data: Uint8Array, work: (ptr: number, len: number) => T): T {
    const ptr = this.#ex.dq_alloc(data.length + 1)
    if (ptr === 0) throw new Error('dquickts allocation failed')
    const bytes = new Uint8Array(this.#ex.memory.buffer)
    bytes.set(data, ptr)
    bytes[ptr + data.length] = 0
    try {
      return work(ptr, data.length)
    } finally {
      this.#ex.dq_free(ptr)
    }
  }
}
