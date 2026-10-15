// A file link (ADR 0070): one owner file handed to an MCP server as a short-lived https URL on goblin's own origin,
// because MCP has no way for a client to upload one. The URL's token (`link-token.ts`) names the user, the file and
// when it expires; the Worker checks it before any agent wakes, and the agent it names reads that file as the owner's
// own download does. Sending the link anywhere is the receiving tool's call, under its own grant and Ask first.
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { epochSeconds } from '../clock.ts'
import { attempt } from '../http/errors.ts'
import { requireResident } from '../mcp/service.ts'
import { logEvent } from '../observability/logger.ts'
import { AgentInput } from '../runtime/input.ts'
import { FILE_LINK_SECONDS, fileLinkToken, fileLinkUrl } from './link-token.ts'
import { Files } from './service.ts'

/**
 * `file_link`'s answer (ADR 0070): a link to the owner's file at `path` (`NotFound` for a directory or nothing), valid
 * for fifteen minutes, with the file's name, type and size. It needs current resident authority.
 */
export const fileLink = Effect.fn('files.link')(function* (path: string) {
  yield* requireResident
  const entry = yield* Files.use((files) => files.stat(path))
  const { env, userId } = yield* AgentInput
  const expiresAt = (yield* epochSeconds) + FILE_LINK_SECONDS
  const token = yield* attempt(() => fileLinkToken(env.CREDENTIAL_KEY, { userId, path: entry.path, expiresAt }))
  return {
    url: fileLinkUrl(env.APP_URL, token, entry.name),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1000)),
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
  }
})

/**
 * The internal API's `linkedFile`: the file a link the Worker checked names, read as the owner's own download reads
 * it, as an attachment with its type and name. It needs current resident authority, as the link it came from did. The
 * line it logs counts the bytes, nothing more.
 */
export const linkedFileDownload = Effect.fn('files.linkedDownload')(function* (path: string) {
  yield* requireResident
  const { entry, body } = yield* Files.use((files) => files.read(path))
  yield* logEvent('info', 'file-link', { count: entry.size })
  return HttpServerResponse.raw(
    new Response(body, {
      headers: {
        'content-type': entry.mimeType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      },
    }),
  )
})
