// Files from MCP content (ADR 0065). A tool result hands media over as links (`resource_link`), embedded resources and
// audio. goblin keeps each one in the owner's files, under `/agent/received/<connection>/<day>/<name>`, and the model
// reads a reference to the file in its place (and a small copy of an image, when it sees images). A public https link
// is fetched as anyone could, never with the connection's credentials; a link of any other scheme is read from its own
// server with `resources/read`, as the owner's grant for that resource allows. A block that cannot be kept becomes a
// short note; the call never fails for it. Nothing here holds a transaction or a lock across a fetch.
import type {
  AudioContent,
  CallToolResult,
  ContentBlock,
  EmbeddedResource,
  ResourceLink,
} from '@modelcontextprotocol/client'
import { type Attachment, FILE_LIMITS, fileName, freeFileName } from '@goblin/contracts'
import * as Data from 'effect/Data'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import { Files } from '../../files/service.ts'
import { readBytes } from '../../http/body.ts'
import { type AppError, PayloadTooLarge, type UpstreamMcp } from '../../http/errors.ts'
import { isRecord } from '../../runtime/digest.ts'
import { AgentInput } from '../../runtime/input.ts'
import { blobBytes } from '../apps/app-html.ts'
import { isPublicHttps } from '../servers/endpoint.ts'
import { McpConnections, McpServers } from '../service.ts'

/** How many redirects a fetched link may take, each to a public https address again. */
const MAX_REDIRECTS = 3

/** How long one link's fetch may take, from its request to its last byte. */
const FETCH_TIMEOUT = '30 seconds'

/** Embedded text longer than this many characters is kept as a file; shorter text stays in the result. */
const LARGE_TEXT = 16 * 1024

/** An image at most this large is also shown to a model that sees images, beside its reference. */
const INLINE_IMAGE_BYTES = 256 * 1024

/** At most this many blocks of one result are kept; the rest are notes. */
const MAX_KEPT = 8

/** The images a model is shown (as the owner's files open them in place). */
const IMAGES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The extension a file of a type usually has, for a name that has none. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** A block goblin keeps as a file. */
type Keepable = ResourceLink | EmbeddedResource | AudioContent

/** A small copy of a kept image, for a model that sees images. */
type InlineImage = { readonly data: string; readonly mimeType: string }

/**
 * What became of one block goblin keeps as a file: written to the owner's files, or a short note saying why not (with
 * the link, without its query and fragment, when it is one the server holds and the owner has not allowed reading).
 */
export type Received =
  | { readonly kind: 'file'; readonly file: Attachment; readonly image?: InlineImage }
  | { readonly kind: 'note'; readonly note: string; readonly link?: { readonly uri: string; readonly name: string } }

/** The kept blocks of one result, by their place in its `content`; a block not here is passed on as it was. */
export type Materialized = ReadonlyMap<number, Received>

/** A result none of whose blocks was kept. */
export const NOTHING_RECEIVED: Materialized = new Map()

type MaterializeOptions<R = never> = {
  /** Whether the model reading the result sees images, asked only when a kept file is a small image. */
  readonly images: Effect.Effect<boolean, never, R>
  /** The caller stopped waiting: a fetch under way is aborted. */
  readonly signal?: AbortSignal
}

/** Why one block was not kept, in a few words the model reads; never its link. */
class NotKept extends Data.TaggedError('NotKept')<{ readonly reason: string }> {}

/** A block's bytes and the type they came with. */
type Bytes = { readonly bytes: Uint8Array; readonly mimeType: string | undefined }

/** A link as goblin records it: without its query and fragment, where a signed URL carries its signature. */
const recordedLink = (uri: string): string => {
  const cut = uri.search(/[?#]/u)
  return cut === -1 ? uri : uri.slice(0, cut)
}

/** `record` without the fields named in `keys`. */
const without = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

/**
 * One block of a result as goblin records it (the transcript, an App's launch, an outcome): a link without its query and
 * fragment, so a signed URL is never kept, and a block goblin `kept` without its bytes, which are in the owner's files.
 */
export function recordedBlock(block: unknown, kept = false): unknown {
  if (!isRecord(block)) return block
  if (block['type'] === 'resource_link' && typeof block['uri'] === 'string')
    return { ...block, uri: recordedLink(block['uri']) }
  if (block['type'] === 'resource' && isRecord(block['resource'])) {
    const resource = kept ? without(block['resource'], ['blob', 'text']) : block['resource']
    const uri = resource['uri']
    return { ...block, resource: typeof uri === 'string' ? { ...resource, uri: recordedLink(uri) } : resource }
  }
  return block['type'] === 'audio' && kept ? without(block, ['data']) : block
}

/** A result's content as goblin records it: each block as {@link recordedBlock} gives it. */
export const recordedContent = (content: unknown, received: Materialized = NOTHING_RECEIVED): unknown =>
  Array.isArray(content)
    ? content.map((block: unknown, index) => recordedBlock(block, received.get(index)?.kind === 'file'))
    : content

/** An MCP App's own resource (`ui://`): the Apps host renders it, so it is never kept as a file. */
const appResource = (uri: string): boolean => uri.startsWith('ui://')

/**
 * Whether goblin keeps `block` as a file: a link, audio, or an embedded resource that is a blob or long text; never an
 * App's own resource.
 */
const keepable = (block: ContentBlock): block is Keepable =>
  (block.type === 'resource_link' && !appResource(block.uri)) ||
  block.type === 'audio' ||
  (block.type === 'resource' &&
    !appResource(block.resource.uri) &&
    ('blob' in block.resource || block.resource.text.length > LARGE_TEXT))

/** A URL, or none for text that is not one. */
const urlOf = (raw: string, base?: URL): URL | undefined => {
  try {
    return new URL(raw, base)
  } catch {
    // expected: a link or a redirect's location that is not a URL is no address to fetch.
    return undefined
  }
}

/**
 * Whether a link is a web address (http or https), which goblin fetches only when it is public https, or no address at
 * all: either way, not one its server reads with `resources/read`.
 */
const onTheWeb = (url: URL | undefined): boolean =>
  url === undefined || url.protocol === 'https:' || url.protocol === 'http:'

/** The last segment of a URI's path, decoded: what a link without a name is called. */
const lastSegment = (uri: string): string => {
  const path = recordedLink(uri).replace(/\/+$/u, '')
  const segment = path.slice(path.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(segment)
  } catch {
    // expected: a segment that is not valid percent-encoding is used as it is written.
    return segment
  }
}

/** A content type as the owner's files keep it: its `type/subtype` in lower case, or none when it is not one. */
const essence = (contentType: string | null | undefined): string | undefined => {
  const value = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return value.length <= 128 && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(value) ? value : undefined
}

/** The type a block says its bytes are. */
const declaredType = (block: Keepable): string | undefined =>
  block.type === 'resource' ? block.resource.mimeType : block.mimeType

/** The name a block's file is given: a link's name or title, else its URI's last segment, else what it is. */
const nameOf = (block: Keepable): string => {
  if (block.type === 'audio') return 'audio'
  const uri = block.type === 'resource' ? block.resource.uri : block.uri
  const names = block.type === 'resource_link' ? [block.name, block.title, lastSegment(uri)] : [lastSegment(uri)]
  return fileName(names.map((name) => name?.trim() ?? '').find((name) => name !== '') ?? block.type)
}

/** `name` with the usual extension of `mimeType` when it has none. */
const withExtension = (name: string, mimeType: string): string => {
  const extension = EXTENSIONS[mimeType]
  return extension === undefined || /\.[A-Za-z0-9]{1,8}$/u.test(name) ? name : fileName(`${name}.${extension}`)
}

/** A connection's folder: its label in lower case, each run of anything else `-`, at most 48 characters. */
const folderName = (label: string): string => {
  const slug = label
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, 48)
    .replaceAll(/^-+|-+$/gu, '')
  return slug === '' ? 'server' : slug
}

/** Bytes as base64, a slice at a time (one spread of a large array overflows the stack). */
const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < bytes.byteLength; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** `url` without its fragment, which is the reader's and never sent. */
const withoutFragment = (url: URL): URL => {
  const sent = new URL(url)
  sent.hash = ''
  return sent
}

/** A response whose body is never read (a redirect, a refusal), cancelled so its connection is let go. */
const drop = (response: Response) =>
  // expected: a body that cannot be cancelled is left to the runtime; nothing here reads it.
  Effect.ignore(Effect.tryPromise(() => (response.body === null ? Promise.resolve() : response.body.cancel())))

/** One request for a link, as anyone could send it: no credentials, no cookies, no redirect followed by itself. */
const send = (fetcher: typeof fetch, url: URL, signal: AbortSignal | undefined) =>
  Effect.tryPromise({
    try: (interrupted) =>
      fetcher(url, {
        redirect: 'manual',
        headers: { accept: '*/*' },
        signal: signal === undefined ? interrupted : AbortSignal.any([interrupted, signal]),
      }),
    catch: () => new NotKept({ reason: 'the request failed' }),
  })

/** Where a redirect goes, when goblin follows it: a public https address, within {@link MAX_REDIRECTS} of the link. */
const redirected = (response: Response, from: URL, redirects: number) => {
  if (redirects === MAX_REDIRECTS) return Effect.fail(new NotKept({ reason: 'it redirected too many times' }))
  const next = urlOf(response.headers.get('location') ?? '', from)
  return next !== undefined && isPublicHttps(next)
    ? Effect.succeed(withoutFragment(next))
    : Effect.fail(new NotKept({ reason: 'it redirected to an address that is not public https' }))
}

/** A response's bytes, at most 25 MiB of them (counted as they arrive, the rest never read), and their type. */
const bodyOf = (response: Response) =>
  Effect.gen(function* () {
    if (!response.ok) {
      yield* drop(response)
      return yield* new NotKept({ reason: `the server answered ${String(response.status)}` })
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readBytes(response, FILE_LIMITS.fileBytes),
      catch: (cause) =>
        new NotKept({ reason: cause instanceof PayloadTooLarge ? 'it is larger than 25 MiB' : 'the download failed' }),
    }).pipe(Effect.tapError(() => drop(response)))
    return { bytes, mimeType: response.headers.get('content-type') ?? undefined } satisfies Bytes
  })

/**
 * A public https link's bytes, fetched without the connection's credentials: at most {@link MAX_REDIRECTS} redirects,
 * each to a public https address again; at most 25 MiB; all within {@link FETCH_TIMEOUT}.
 */
const download = (fetcher: typeof fetch, link: URL, signal?: AbortSignal) =>
  Effect.gen(function* () {
    let url = withoutFragment(link)
    for (let redirects = 0; ; redirects += 1) {
      const response = yield* send(fetcher, url, signal)
      if (!REDIRECT_STATUSES.has(response.status)) return yield* bodyOf(response)
      yield* drop(response)
      url = yield* redirected(response, url, redirects)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () => Effect.fail(new NotKept({ reason: 'it took longer than 30 seconds' })),
    }),
  )

/** Why a server could not serve a linked resource, in goblin's words. */
const UPSTREAM: Readonly<Record<UpstreamMcp['reason'], string>> = {
  'content-limit': 'it is larger than goblin reads from a server',
  'remote-rpc': 'the server did not serve it',
  unsupported: 'the server did not serve it',
  unauthorized: 'the connection needs signing in',
  transport: 'the server could not be reached',
  timeout: 'the server could not be reached',
  cancelled: 'the call was stopped',
}

/** Why a linked resource could not be read from its server, in goblin's words (never the server's). */
const unreadable = (error: AppError): NotKept =>
  new NotKept({
    reason: Match.value(error).pipe(
      Match.tags({
        GrantDenied: () => 'the owner has not allowed reading it',
        NeedsAuthorization: () => 'the connection needs signing in',
        UpstreamMcp: (upstream) => UPSTREAM[upstream.reason],
      }),
      Match.orElse(() => 'it could not be read'),
    ),
  })

/** One resource's bytes: its text as UTF-8, or its blob decoded and bounded. */
const resourceBytes = (resource: {
  readonly text?: unknown
  readonly blob?: unknown
  readonly mimeType?: string | undefined
}) =>
  Effect.gen(function* () {
    if (typeof resource.text === 'string')
      return { bytes: new TextEncoder().encode(resource.text), mimeType: resource.mimeType } satisfies Bytes
    const decoded = blobBytes(resource.blob, FILE_LIMITS.fileBytes)
    if ('failure' in decoded)
      return yield* new NotKept({
        reason: decoded.failure === 'too-large' ? 'it is larger than 25 MiB' : 'its bytes are not base64',
      })
    return { bytes: decoded.bytes, mimeType: resource.mimeType } satisfies Bytes
  })

/**
 * A link of any scheme but the web's, read from its own server with `resources/read`, as the owner's grant for that
 * resource allows (the host checks it, as for any resource read).
 */
const readLinked = (connectionId: string, uri: string) =>
  Effect.gen(function* () {
    const result = yield* McpConnections.use((connections) =>
      connections.readResource(connectionId, uri, 'human'),
    ).pipe(Effect.mapError(unreadable))
    const content = result.contents.find((item) => item.uri === uri) ?? result.contents[0]
    if (content === undefined) return yield* new NotKept({ reason: 'the server sent nothing' })
    return yield* resourceBytes(content)
  })

/** A block's bytes: a link fetched or read, an embedded resource or audio decoded. */
const bytesOf = (connectionId: string, block: Keepable, fetcher: typeof fetch, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    if (block.type === 'audio') return yield* resourceBytes({ blob: block.data, mimeType: block.mimeType })
    if (block.type === 'resource') return yield* resourceBytes(block.resource)
    const url = urlOf(block.uri)
    if (url !== undefined && isPublicHttps(url)) return yield* download(fetcher, url, signal)
    if (onTheWeb(url)) return yield* new NotKept({ reason: 'it is not a public https address' })
    return yield* readLinked(connectionId, block.uri)
  })

/** A size for people: KiB below a MiB, else MiB. */
const sized = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KiB` : `${String(Math.round(bytes / (1024 * 1024)))} MiB`

/**
 * Why a kept file could not be written, in goblin's words: the owner's storage is full, or the file is larger than one
 * file may be here (a deployment without the files bucket keeps none over 128 KiB, ADR 0064).
 */
const unwritable = (error: AppError): NotKept =>
  new NotKept({
    reason: Match.value(error).pipe(
      Match.tags({
        PayloadTooLarge: ({ limit }) =>
          limit === FILE_LIMITS.totalBytes ? "the owner's files are full" : `it is larger than ${sized(limit)}`,
        InvalidInput: (invalid) =>
          invalid.reason === 'too many files' ? "the owner's files hold too many files" : 'it could not be saved',
      }),
      Match.orElse(() => 'it could not be saved'),
    ),
  })

/** The note a block that was not kept leaves: what it is, its name and why; a resource link keeps its reference. */
const noteOf = (block: Keepable, name: string, reason: string): Received => {
  if (block.type !== 'resource_link') return { kind: 'note', note: `could not keep ${name}: ${reason}` }
  const note = `could not fetch ${name}: ${reason}`
  // A link only its server reads stays a reference the model can name to the owner; a web address does not.
  return onTheWeb(urlOf(block.uri))
    ? { kind: 'note', note }
    : { kind: 'note', note, link: { uri: recordedLink(block.uri), name } }
}

/**
 * Where one result's files go, and what keeping them needs: the folder, with its names read once before the first write
 * (so a file never replaces one already there), the fetch, and whether the model sees images (asked once, if ever).
 */
type Keeping<R> = {
  readonly connectionId: string
  readonly folder: string
  readonly fetcher: typeof fetch
  readonly options: MaterializeOptions<R>
  taken: Set<string> | undefined
  sees: boolean | undefined
}

/** The names in the folder, read on the first write and then kept up to date here. */
const takenIn = <R>(keeping: Keeping<R>) =>
  Effect.gen(function* () {
    if (keeping.taken !== undefined) return keeping.taken
    const listing = yield* Files.use((files) => files.list(keeping.folder)).pipe(Effect.mapError(unwritable))
    keeping.taken = new Set(listing.entries.map((entry) => entry.name))
    return keeping.taken
  })

/** Whether the model sees images, asked once. */
const seesImages = <R>(keeping: Keeping<R>) =>
  Effect.gen(function* () {
    keeping.sees ??= yield* keeping.options.images
    return keeping.sees
  })

/** One block kept: its bytes fetched, read or decoded, written under a free name, and a small image copied. */
const keep = <R>(keeping: Keeping<R>, block: Keepable, named: string) =>
  Effect.gen(function* () {
    const { bytes, mimeType } = yield* bytesOf(keeping.connectionId, block, keeping.fetcher, keeping.options.signal)
    const type = essence(mimeType) ?? essence(declaredType(block)) ?? 'application/octet-stream'
    const taken = yield* takenIn(keeping)
    const name = freeFileName(withExtension(named, type), taken)
    taken.add(name)
    const entry = yield* Files.use((files) =>
      files.write('agent', `${keeping.folder}/${name}`, bytes, type, bytes.byteLength),
    ).pipe(Effect.mapError(unwritable))
    const file = { path: entry.path, name: entry.name, size: entry.size, mimeType: entry.mimeType }
    const small = IMAGES.has(type) && bytes.byteLength <= INLINE_IMAGE_BYTES
    return small && (yield* seesImages(keeping))
      ? ({ kind: 'file', file, image: { data: base64(bytes), mimeType: type } } satisfies Received)
      : ({ kind: 'file', file } satisfies Received)
  })

/**
 * Keeps the files a tool result hands over (its links, embedded resources and audio) in the owner's files, and answers
 * what became of each such block, by its place in the result. It never fails: a block that cannot be kept is a note.
 * The model's `mcp_call` uses it, and any other reader of a server's content may.
 */
export const materialize = Effect.fn('mcp.materialize')(function* <R = never>(
  connectionId: string,
  result: CallToolResult,
  options: MaterializeOptions<R>,
) {
  const received = new Map<number, Received>()
  const blocks = result.content.flatMap((block, index) => (keepable(block) ? [{ block, index }] : []))
  if (blocks.length === 0) return received
  const label = (yield* McpServers.use((servers) => servers.labels())).get(connectionId) ?? connectionId
  const day = DateTime.formatIsoDateUtc(yield* DateTime.now)
  const keeping: Keeping<R> = {
    connectionId,
    folder: `/agent/received/${folderName(label)}/${day}`,
    fetcher: (yield* AgentInput).mcpFetch,
    options,
    taken: undefined,
    sees: undefined,
  }
  // One block at a time: a file's bytes are held only until it is written.
  for (const [order, { block, index }] of blocks.entries()) {
    const named = nameOf(block)
    const outcome =
      order < MAX_KEPT
        ? keep(keeping, block, named)
        : Effect.fail(new NotKept({ reason: `one result keeps at most ${String(MAX_KEPT)} files` }))
    received.set(
      index,
      yield* outcome.pipe(Effect.catchTag('NotKept', ({ reason }) => Effect.succeed(noteOf(block, named, reason)))),
    )
  }
  return received
})
