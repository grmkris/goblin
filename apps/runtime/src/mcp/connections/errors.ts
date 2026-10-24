import {
  InsufficientScopeError,
  OAuthClientFlowError,
  OAuthError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import * as Predicate from 'effect/Predicate'
import {
  type AppError,
  Internal,
  NeedsAuthorization,
  ScopeRequired,
  UpstreamMcp,
  toAppError,
} from '../../http/errors.ts'

/**
 * Whether an OAuth step failed because the authorization server (or the MCP server) refused this agent: an OAuth error
 * answer (`invalid_grant`, a rejected registration), a flow the SDK refused to continue, a 401, or our own
 * `NeedsAuthorization`. Only these mean the owner must sign in again; a network or server failure does not, and nor
 * does a call beyond the granted scope, which asks for more access instead (ADR 0042).
 */
export const isOAuthRejection = (error: unknown): boolean =>
  !InsufficientScopeError.isInstance(error) &&
  (OAuthError.isInstance(error) ||
    OAuthClientFlowError.isInstance(error) ||
    UnauthorizedError.isInstance(error) ||
    error instanceof NeedsAuthorization)

/** At most this many scope tokens, and characters, are kept from a server's challenge. */
const SCOPE_TOKENS = 32
const SCOPE_CHARS = 512
/** One OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u

/** The scope a challenge asks for, as scope tokens only: anything else in the server's text is dropped. */
export const challengeScope = (scope: string | undefined): string =>
  (scope ?? '')
    .split(' ')
    .filter((token) => SCOPE_TOKEN.test(token))
    .slice(0, SCOPE_TOKENS)
    .join(' ')
    .slice(0, SCOPE_CHARS)

/**
 * A remote text as one line of at most `max` characters: control characters and runs of space become one space, and a
 * longer text is cut at a whole character and ends in `…`.
 */
export const oneLine = (text: string, max: number): string => {
  const read = text.slice(0, max * 4)
  const folded = Array.from(read.replaceAll(/[\s\p{Cc}]+/gu, ' ').trim())
  return folded.length <= max && read.length === text.length
    ? folded.join('')
    : `${folded
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/** At most this many characters of a server's JSON-RPC error are kept. */
const SERVER_MESSAGE = 500

/**
 * What a server's JSON-RPC error says, as one bounded line: its message, and its `data` when that is text; nothing else
 * of `data`. None when it says nothing.
 */
const serverMessageOf = (error: ProtocolError): { readonly serverMessage?: string } => {
  const parts = [error.message, Predicate.isString(error.data) ? error.data : ''].filter((part) => part.trim() !== '')
  const said = oneLine(parts.join(': '), SERVER_MESSAGE)
  return said === '' ? {} : { serverMessage: said }
}

/** A request timeout's data names the deadline it missed: one request's (`timeout`) or the whole call's. */
const missedDeadline = (data: unknown): boolean =>
  Predicate.isObject(data) && ('timeout' in data || 'maxTotalTimeout' in data)

/**
 * Map an SDK or transport failure to a safe `UpstreamMcp`, or a call beyond the granted scope to `ScopeRequired`; app
 * errors raised by our own code pass through. The token, request and response are never retained. Of a server's
 * JSON-RPC error, its code is kept, and its message as one bounded line in its own words (`serverMessage`, ADR 0092):
 * the model reads it as the server's, and it never enters the API's envelope, telemetry or logs.
 */
export const mapMcpError = (error: unknown, connectionId: string): AppError => {
  if (InsufficientScopeError.isInstance(error))
    return new ScopeRequired({ connectionId, scope: challengeScope(error.requiredScope) })
  if (UnauthorizedError.isInstance(error)) return new UpstreamMcp({ connectionId, reason: 'unauthorized' })
  if (ProtocolError.isInstance(error))
    return new UpstreamMcp({ connectionId, reason: 'remote-rpc', code: error.code, ...serverMessageOf(error) })
  if (SdkHttpError.isInstance(error)) return new UpstreamMcp({ connectionId, reason: 'transport' })
  // The SDK reports a caller's abort as a timeout too; only a deadline it (or goblin) set carries how long it was.
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout)
    return new UpstreamMcp({ connectionId, reason: missedDeadline(error.data) ? 'timeout' : 'cancelled' })
  if (error instanceof DOMException && error.name === 'AbortError')
    return new UpstreamMcp({ connectionId, reason: 'cancelled' })
  const known = toAppError(error)
  return known instanceof Internal ? new UpstreamMcp({ connectionId, reason: 'transport' }) : known
}
