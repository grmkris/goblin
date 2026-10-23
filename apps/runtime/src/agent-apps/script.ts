import { RpcTarget } from 'cloudflare:workers'
import * as Schema from 'effect/Schema'
import { type FileView, pathIn } from '../files/folders.ts'
import type { FileStore } from '../files/store.ts'
import type { Isolates } from './isolates.ts'
import { plainJson } from './json.ts'
import { problemText, refusalOf } from './queue.ts'
import { sha256Hex } from '../runtime/digest.ts'

/** How much of a file a script reads at once, and how long a script may take. */
const READ_BYTES = 1024 * 1024
const SCRIPT_MS = 30_000

/**
 * The files as a one-off script sees them: what its turn's view reads (ADR 0115), and writing only its Topic's `agent`
 * folder, where a path without a leading `/` is.
 */
class ScriptFiles extends RpcTarget {
  readonly #files: FileStore
  readonly #view: FileView

  constructor(files: FileStore, view: FileView) {
    super()
    this.#files = files
    this.#view = view
  }

  async read(path: string): Promise<string> {
    try {
      return (await this.#files.text(this.#view, pathIn(this.#view, path), 0, READ_BYTES)).text
    } catch (cause) {
      throw refusalOf(cause)
    }
  }

  async list(dir: string): Promise<readonly { readonly path: string; readonly size: number; readonly kind: string }[]> {
    try {
      return (await this.#files.list(this.#view, pathIn(this.#view, dir))).entries.map(({ path, size, kind }) => ({
        path,
        size,
        kind,
      }))
    } catch (cause) {
      throw refusalOf(cause)
    }
  }

  async write(path: string, text: string): Promise<string> {
    try {
      const size = new TextEncoder().encode(text).byteLength
      const target = pathIn(this.#view, path)
      return (await this.#files.write(this.#view, target, text, 'text/plain; charset=utf-8', size)).path
    } catch (cause) {
      throw refusalOf(cause)
    }
  }
}

/** The script's module: its code is the body of an async function with `files` and `log` in scope. */
const moduleOf = (code: string) => `import { WorkerEntrypoint } from 'cloudflare:workers'
export class Run extends WorkerEntrypoint {
  async run(files) {
    const logs = []
    const log = (...parts) => {
      if (logs.length < 100) logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ').slice(0, 500))
    }
    try {
      const value = await (async () => {
${code}
      })()
      return { ok: true, value: value === undefined ? null : value, logs }
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error).slice(0, 4000), logs }
    }
  }
}
export default {}
`

/** What `code_run` returns: whether the script finished, its value as JSON or its error, and what it logged. */
export const ScriptResult = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
  logs: Schema.Array(Schema.String),
})
export type ScriptResult = typeof ScriptResult.Type

/**
 * Runs a one-off JavaScript snippet in its own isolate (`code_run`): no network, the files `view` reaches through
 * `files`, `log(...)` for notes, and its return value back as JSON.
 */
export async function runScript(
  isolates: Isolates,
  files: { readonly store: FileStore; readonly view: FileView },
  code: string,
): Promise<ScriptResult> {
  const id = (await sha256Hex(code)).slice(0, 24)
  const script = isolates.script(id, moduleOf(code))
  try {
    const result = await isolates.call(SCRIPT_MS, 'the script', () =>
      script.run(new ScriptFiles(files.store, files.view)),
    )
    // SAFETY: plainJson returns the value only once it is plain JSON within the limit.
    const value = plainJson(result.value ?? null, 256 * 1024, 'the result') as Schema.Json
    return { ok: result.ok, value, ...(result.error === undefined ? {} : { error: result.error }), logs: result.logs }
  } catch (cause) {
    // expected: a script that fails or times out answers `code_run` with its error, for the agent to read
    return { ok: false, error: problemText(cause), logs: [] }
  }
}
