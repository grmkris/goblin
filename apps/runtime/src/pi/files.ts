import { defineExtension, section } from '@earendil-works/pi-durable'
import { FileEntry, FileListing } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { fileLink } from '../files/link.ts'
import { Files } from '../files/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { typedTool } from './typed-tool.ts'

/** How much of a file one `files_read` returns. */
const READ_BYTES = 48 * 1024

/** What a file whose bytes are text can be: read as text; anything else is described, not dumped. */
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|csv|x-yaml|yaml|javascript|typescript|x-ndjson))/u
const TEXT_NAMES = /\.(?:txt|md|csv|tsv|json|jsonl|ndjson|xml|ya?ml|html?|css|js|ts|tsx|jsx|log|ini|toml)$/iu

const isText = (entry: FileEntry): boolean => TEXT_TYPES.test(entry.mimeType) || TEXT_NAMES.test(entry.name)

const GUIDE = [
  "The owner's files: `/uploads` holds what they uploaded or attached to a message (you read them, never write them),",
  '`/agent` is yours to write: reports, data and results the owner may want to keep. A message with attachments names',
  'their paths; read one with `files_read` before answering about it. Say the path of anything you write. To hand a',
  "file to one of the owner's tools that takes a URL (sending a photo or a document), make a link with `file_link`.",
].join(' ')

const Path = Schema.String.check(Schema.isMaxLength(512))

const FILE_TOOLS: readonly string[] = ['files_list', 'files_read', 'files_write', 'file_link', 'files_delete']

/** A part of a text file and where the next part starts, or the entry of a file whose bytes are not text. */
const FilePart = Schema.Struct({
  entry: FileEntry,
  text: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(Schema.Int),
  note: Schema.optionalKey(Schema.String),
})

/** What `file_link` answers: the link, when it stops working, and the file it leads to. */
const FileLink = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})

/**
 * `files_list`, `files_read`, `files_write` and `files_delete` over the owner's files (ADR 0022), and `file_link`, a
 * short-lived link to one of them (ADR 0070).
 */
export function filesExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.files',
    // Only where the tools are offered: a turn whose power lacks them has them filtered out (ADR 0115).
    sections: [
      section('files', (input) =>
        input.agent.tools.some((offered) => FILE_TOOLS.includes(offered.name)) ? GUIDE : undefined,
      ),
    ],
    tools: [
      typedTool({
        name: 'files_list',
        description: 'List a directory of the owner\'s files: "/uploads", "/agent" or a folder under one.',
        input: Schema.Struct({ dir: Path }),
        output: FileListing,
        replay: 'safe',
        execute: async ({ dir }) => run(Files.use((files) => files.list(dir))),
      }),
      typedTool({
        name: 'files_read',
        description: `Read a text file, ${READ_BYTES / 1024} KB at a time from byte \`offset\` (the result says where the next part starts).`,
        input: Schema.Struct({
          path: Path,
          offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        }),
        output: FilePart,
        replay: 'safe',
        execute: async ({ path, offset }) =>
          run(
            Effect.gen(function* () {
              const files = yield* Files
              const entry = yield* files.stat(path)
              if (!isText(entry)) return { entry, note: 'Not a text file: its bytes are not shown.' }
              return yield* files.text(path, offset ?? 0, READ_BYTES)
            }),
          ),
      }),
      typedTool({
        name: 'files_write',
        description: 'Write a text file under /agent (replacing one with the same path). Returns its entry.',
        input: Schema.Struct({
          path: Path,
          content: Schema.String.check(Schema.isMaxLength(1_000_000)),
          mimeType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
        }),
        output: FileEntry,
        replay: 'safe',
        execute: async ({ path, content, mimeType }) => {
          const size = new TextEncoder().encode(content).byteLength
          return run(
            Files.use((files) => files.write('agent', path, content, mimeType ?? 'text/plain; charset=utf-8', size)),
          )
        },
      }),
      typedTool({
        name: 'file_link',
        description:
          "A link to one of the owner's files, for a tool that takes a file by URL (a photo or a document to send): an https URL that works for 15 minutes and serves only that file, with its name, type and size. Making it sends nothing; passing it to a tool is that tool's call, under its own access and Ask first, so only pass it where the owner wants the file to go.",
        input: Schema.Struct({ path: Path }),
        output: FileLink,
        replay: 'safe',
        execute: async ({ path }) => run(fileLink(path)),
      }),
      typedTool({
        name: 'files_delete',
        description: 'Delete a file under /agent.',
        input: Schema.Struct({ path: Path }),
        output: Schema.Struct({ deleted: Schema.String }),
        replay: 'safe',
        execute: async ({ path }) => {
          await run(Files.use((files) => files.remove('agent', path)))
          return { deleted: path }
        },
      }),
    ],
  })
}
