import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'

// The pure policy of the Events goblin publishes (ADR 0112): the callback URL, the secret, the lease, the lease's id,
// retries and the challenge's echo. Copied, with goblin's own errors, from myapps `packages/mcp/src/events/policy.ts`
// and `delivery.ts` (`eventCallbackUrl`, `eventSecret`, `eventTtlMs`, `canonicalEventJson`, `eventSubscriptionId`,
// `eventRetryDecision`, `eventChallengeMatches`) at origin/dev, since that package is private and D1-bound.

/** The approved profile's bounds, as myapps' `EVENT_LIMITS` sets them, with goblin's own per-holder and per-workspace counts. */
export const PUBLISH_LIMITS = {
  defaultTtlMs: 3_600_000,
  minTtlMs: 300_000,
  maxTtlMs: 86_400_000,
  /** Leases one holder (a key, a client for a person, a member) may hold, and the whole workspace. */
  perHolder: 32,
  perWorkspace: 256,
  pageEvents: 100,
  bodyBytes: 262_144,
  timeoutMs: 5_000,
  attempts: 5,
  retryWindowMs: 900_000,
  /** How long the journal keeps an occurrence. */
  retentionMs: 604_800_000,
  /** How long an empty poll is told to wait. */
  nextPollMs: 10_000,
} as const

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.invalid', '.test', '.example']

/**
 * A callback URL a lease may name, checked again before every attempt: https on a public name, with no port,
 * credentials, fragment, IP literal or local suffix, written exactly as the URL parser would write it. Anything else is
 * `InvalidInput` `event_callback_url`. DNS cannot be pinned in Workers: trusted DNS is the documented assumption.
 */
export function callbackUrl(raw: string): string {
  const refused = new InvalidInput({ reason: 'event_callback_url' })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw refused
  }
  const host = url.hostname
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    raw.includes('#') ||
    url.port !== '' ||
    url.href !== raw ||
    host.startsWith('[') ||
    /^\d+(?:\.\d+){3}$/u.test(host) ||
    !host.includes('.') ||
    host.endsWith('.') ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    throw refused
  return raw
}

/** A Standard Webhooks secret: `whsec_` and canonical base64 of 24 to 64 bytes; anything else is `event_secret`. */
export function webhookSecret(secret: string): string {
  const refused = new InvalidInput({ reason: 'event_secret' })
  const encoded = secret.slice(6)
  if (!secret.startsWith('whsec_') || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw refused
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    throw refused
  }
  if (binary.length < 24 || binary.length > 64 || btoa(binary).replace(/=+$/u, '') !== encoded.replace(/=+$/u, ''))
    throw refused
  return secret
}

/** A lease's length: the one asked for, an hour when none was, never below five minutes or past a day. */
export const leaseMs = (asked: number | null | undefined): number =>
  Math.max(PUBLISH_LIMITS.minTtlMs, Math.min(asked ?? PUBLISH_LIMITS.defaultTtlMs, PUBLISH_LIMITS.maxTtlMs))

const sortedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (Predicate.isReadonlyObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortedJson(entry)] as const),
    )
  return value
}

/** JSON with every object's keys in order, arrays as they are: the same arguments always read the same. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortedJson(value))

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** A lease's id: the hash of its holder, its exact URL and its selector, so subscribing again finds the same lease. */
export async function subscriptionId(
  holder: string,
  selector: { readonly name: string; readonly arguments: unknown },
  url: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ principal: holder, url, ...selector }))
  return `sub_${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}`
}

/** Why an attempt did not reach the receiver, as a lease's `lastError` names it. */
export type CallbackReason = 'connection_refused' | 'timeout' | 'http_4xx' | 'http_5xx' | 'challenge_failed'

/** What happens to a delivery after one attempt: done, tried again at `atMs`, or given up on. */
export type RetryDecision =
  | { readonly state: 'accepted'; readonly atMs: number }
  | { readonly state: 'retry'; readonly atMs: number; readonly reason: CallbackReason }
  | { readonly state: 'abandoned'; readonly atMs: number; readonly reason: CallbackReason }

/**
 * After attempt `attempts` (from 1): a 2xx is accepted; a redirect, 410 or 413, the fifth attempt or the end of the
 * fifteen-minute window gives up; anything else is tried again 15 s·2ⁿ later (at most five minutes), with ±25% jitter.
 */
export function retryDecision(input: {
  readonly status?: number | undefined
  readonly reason?: CallbackReason | undefined
  readonly attempts: number
  readonly firstAttemptMs: number
  readonly nowMs: number
  /** In [0, 1]. */
  readonly jitter: number
  /** The first retry's delay, 15 s unless a fixture sets less. */
  readonly baseMs?: number | undefined
}): RetryDecision {
  const { status, attempts, firstAttemptMs, nowMs } = input
  if (status !== undefined && status >= 200 && status < 300) return { state: 'accepted', atMs: nowMs }
  const reason = input.reason ?? (status !== undefined && status >= 500 ? 'http_5xx' : 'http_4xx')
  const deadline = firstAttemptMs + PUBLISH_LIMITS.retryWindowMs
  const delay =
    Math.min(300_000, (input.baseMs ?? 15_000) * 2 ** Math.min(attempts - 1, 4)) *
    (0.75 + Math.max(0, Math.min(input.jitter, 1)) * 0.5)
  const atMs = Math.ceil(nowMs + delay)
  if (
    status === 410 ||
    status === 413 ||
    (status !== undefined && status >= 300 && status < 400) ||
    attempts >= PUBLISH_LIMITS.attempts ||
    nowMs >= deadline ||
    atMs >= deadline
  )
    return { state: 'abandoned', atMs: nowMs, reason }
  return { state: 'retry', atMs, reason }
}

/** Whether a receiver echoed `challenge` as `{"challenge": …}`, compared without an early exit. */
export function challengeMatches(body: Uint8Array, challenge: string): boolean {
  if (body.byteLength > PUBLISH_LIMITS.bodyBytes) return false
  let echo: string
  try {
    echo = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)),
    ).challenge
  } catch {
    // expected: an answer that is not the echo is a failed challenge.
    return false
  }
  const left = new TextEncoder().encode(echo)
  const right = new TextEncoder().encode(challenge)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}
