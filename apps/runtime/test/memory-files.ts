import { FILE_LIMITS, type FileEntry } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Files } from '../src/files/service.ts'
import { filePath, mayWrite } from '../src/files/store.ts'
import { PayloadTooLarge, attemptSync } from '../src/http/errors.ts'
import { stub } from './http/api/fixture.ts'

/** One file the store holds: its bytes and type. */
type Stored = { readonly bytes: Uint8Array; readonly mimeType: string }

const entryOf = (path: string, { bytes, mimeType }: Stored): FileEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'file',
  size: bytes.byteLength,
  mimeType,
  updatedAt: 0,
})

/**
 * The owner's files in memory, held to the store's rules (a path `FILE_PATH` accepts, a view's writes, ADR
 * 0115): what each directory lists and what was written, by path. A store `full` refuses every write as over its
 * limit, and one with a `fileLimit` (a deployment without the files bucket) any larger file. Only listing and writing
 * are served.
 */
export function memoryFiles(held: Readonly<Record<string, string>> = {}) {
  const encoder = new TextEncoder()
  const written = new Map<string, Stored>(
    Object.entries(held).map(([path, text]) => [path, { bytes: encoder.encode(text), mimeType: 'text/plain' }]),
  )
  const state: { full: boolean; fileLimit?: number } = { full: false }
  const layer = stub(Files, {
    list: (_view, dir) =>
      Effect.sync(() => ({
        entries: [...written]
          .filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
          .map(([path, file]) => entryOf(path, file)),
        usedBytes: 0,
        limitBytes: FILE_LIMITS.totalBytes,
      })),
    write: (view, path, body, mimeType, size) =>
      attemptSync(() => {
        mayWrite(view, filePath(path))
        if (state.full) throw new PayloadTooLarge({ limit: FILE_LIMITS.totalBytes })
        if (state.fileLimit !== undefined && size > state.fileLimit)
          throw new PayloadTooLarge({ limit: state.fileLimit })
        if (!(body instanceof Uint8Array) || body.byteLength !== size) throw new Error('the test writes bytes only')
        const file = { bytes: body, mimeType }
        written.set(path, file)
        return entryOf(path, file)
      }),
  })
  return { written, state, layer }
}
