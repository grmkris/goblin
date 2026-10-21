// The owner's files as the browser reaches them (ADR 0022): uploads for a message go to `/uploads/<day>/`, under a
// name the runtime's path rule accepts and that replaces nothing already there. The listing goes through the typed
// owner API; an upload sends the file's bytes as its body, so this module sends it itself, with the headers the typed
// client sends.
import { type Attachment, FILE_LIMITS, FileEntry, fileName, freeFileName } from '@goblin/contracts'
import { API_ERRORS, PayloadTooLarge } from '@goblin/contracts/api'
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { owner, requestId } from './api.ts'
import { answerRef } from './query/app-error.ts'
import { pad } from './format.ts'
import { apiPath } from './workspace-path.ts'

/** The day's upload folder, by the owner's local date. */
export function uploadFolder(now: Date): string {
  return `/uploads/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Where a stored file downloads from (only plain images open in place). */
export const fileUrl = (path: string): string => apiPath(`/api/files/content?path=${encodeURIComponent(path)}`)

/** A size for people: bytes, KB or MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const decodeEntry = Schema.decodeUnknownSync(FileEntry)
const decodeEnvelope = Schema.decodeUnknownOption(Schema.Union(API_ERRORS))

/** An upload whose answer names no failure: its status says what happened, and `ref` is what the owner quotes. */
class FilesFailure extends Data.TaggedError('FilesFailure')<{ readonly status: number; readonly ref: string }> {}

/**
 * One upload (`PUT /api/files/content`): same-origin with the session cookie, a fresh request id and the CSRF header,
 * the file as the body. A refusal is the typed failure its envelope names, quoting the request's reference.
 */
async function put(url: string, file: File, type: string): Promise<unknown> {
  const sent = requestId()
  const response = await fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-goblin-request': sent, 'x-goblin-csrf': '1', 'content-type': type },
    body: file,
  })
  // expected: a body that is not JSON leaves the status to say what happened
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw Option.getOrElse(
      decodeEnvelope(data),
      () =>
        new FilesFailure({
          status: response.status,
          ref: answerRef((name) => response.headers.get(name)) ?? sent,
        }),
    )
  return data
}

/**
 * Uploads `file` into today's folder under a name nobody holds there (`taken` adds the names this batch already
 * chose), and returns it as an attachment for the next message.
 */
export async function uploadAttachment(file: File, taken: Set<string>, now = new Date()): Promise<Attachment> {
  if (file.size > FILE_LIMITS.fileBytes) throw new PayloadTooLarge({ limit: FILE_LIMITS.fileBytes })
  const folder = uploadFolder(now)
  const listing = await owner.run((api) => api.files.list({ query: { dir: folder } }))
  const held = new Set([...taken, ...listing.entries.map((entry) => entry.name)])
  const name = freeFileName(fileName(file.name), held)
  taken.add(name)
  const type = file.type === '' ? 'application/octet-stream' : file.type
  const entry = decodeEntry(await put(fileUrl(`${folder}/${name}`), file, type))
  return { path: entry.path, name: entry.name, size: entry.size, mimeType: entry.mimeType }
}
