import type { FileEntry, FileListing } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { FileView } from './folders.ts'

/** A part of a text file, and where the next part starts when there is more. */
export type FileText = { readonly entry: FileEntry; readonly text: string; readonly next?: number }

/**
 * The workspace's files (ADRs 0022, 0115): each Topic's folder (`/topics/<id>/uploads`, `/topics/<id>/agent`) and the
 * Shared folder (`/uploads`, `/agent`). Every method takes the caller's view (`files/folders.ts`): the owner reads and
 * writes everything, a turn its own Topic's folder (every Topic's from a hub) and the Shared folder on a person's
 * turn, and writes only its Topic's `agent` folder; quotas are checked before every write.
 */
export class Files extends Context.Service<
  Files,
  {
    /** A directory's entries the view reads, newest first, and the storage in use. */
    readonly list: (view: FileView, dir: string) => Effect.Effect<FileListing, AppError>
    /** A file's entry; `NotFound` for a directory, nothing or a file outside the view. */
    readonly stat: (view: FileView, path: string) => Effect.Effect<FileEntry, AppError>
    /** A file's bytes as a stream, with its entry. */
    readonly read: (
      view: FileView,
      path: string,
    ) => Effect.Effect<{ readonly entry: FileEntry; readonly body: ReadableStream<Uint8Array> }, AppError>
    /** At most `maxBytes` of a file's text from byte `offset`. */
    readonly text: (view: FileView, path: string, offset: number, maxBytes: number) => Effect.Effect<FileText, AppError>
    /** Writes `body` (`size` bytes, as declared) to `path` within the view, once the quotas allow it. */
    readonly write: (
      view: FileView,
      path: string,
      body: string | Uint8Array | ReadableStream<Uint8Array>,
      mimeType: string,
      size: number,
    ) => Effect.Effect<FileEntry, AppError>
    /** Deletes the file at `path` within the view. */
    readonly remove: (view: FileView, path: string) => Effect.Effect<void, AppError>
  }
>()('goblin/files/Files') {}
