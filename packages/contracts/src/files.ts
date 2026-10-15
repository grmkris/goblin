import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

const MIB = 1024 * 1024

/** The owner's storage limits (ADR 0022): per file, in total, and how many files. */
export const FILE_LIMITS = { fileBytes: 25 * MIB, totalBytes: 512 * MIB, files: 2000 } as const

/**
 * A path in the owner's files (ADR 0022): under `/uploads` (what the owner uploaded) or `/agent` (what the agent wrote),
 * at most eight plain segments of letters, digits, spaces and `_ . ( ) -`, none of them only dots.
 */
export const FILE_PATH = /^\/(?:uploads|agent)(?:\/(?!\.+(?:\/|$))[\p{L}\p{N}_ .()-]{1,80}){1,8}$/u

export const FilePath = Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(FILE_PATH))
export type FilePath = typeof FilePath.Type

/** The longest name one segment of a file path may have (`FILE_PATH`). */
const NAME_LIMIT = 80

/**
 * A file name `FILE_PATH` accepts, from any name: other characters become `-`, runs of space one, and a long name keeps
 * its extension. The web names uploads with it and the runtime the files it keeps (ADR 0065).
 */
export function fileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/[^\p{L}\p{N}_ .()-]/gu, '-')
    .trim()
  if (/^\.*$/u.test(cleaned)) return 'file'
  if (cleaned.length <= NAME_LIMIT) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, NAME_LIMIT - extension.length).trimEnd()}${extension}`
}

/** `name`, or `name (2)`, `name (3)`… with its extension kept, whichever `taken` does not hold yet. */
export function freeFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})${extension}`
    const candidate = `${stem.slice(0, NAME_LIMIT - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The directory a listing starts from: a file path, or one of the two areas itself. */
export const FileDirectory = Schema.Union([Schema.Literals(['/uploads', '/agent']), FilePath])

export const FileEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['file', 'directory']),
  size: Schema.Number,
  mimeType: Schema.String,
  updatedAt: Schema.Number,
})
export type FileEntry = typeof FileEntry.Type

/** A directory's entries, and how much of the owner's storage is in use. */
export const FileListing = Schema.Struct({
  entries: Schema.Array(FileEntry),
  usedBytes: Schema.Number,
  limitBytes: Schema.Number,
})
export type FileListing = typeof FileListing.Type

/** A file the owner attached to a message: shown on the message, read by the agent with `files_read`. */
export const Attachment = Schema.Struct({
  path: FilePath,
  name: NonEmptyString(80),
  size: Schema.Number,
  mimeType: Schema.String.check(Schema.isMaxLength(128)),
})
export type Attachment = typeof Attachment.Type

/**
 * The files goblin kept in the owner's files from one MCP tool result (ADR 0065): its links, embedded resources and
 * audio, written under `/agent/received/`. A model call's result details carry them as `received`, which the web shows
 * as chips under the call.
 */
export const ReceivedFiles = Schema.Array(Attachment)
