import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Random from 'effect/Random'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { type AppError, attempt, attemptSync } from '../http/errors.ts'
import { sign } from '../mcp/events/webhook.ts'
import type { CredentialCipher } from '../mcp/oauth/cipher.ts'
import { reportAndRecover } from '../observability/report.ts'
import { type Claimed, claimDue, settle } from './leases.ts'
import { type CallbackReason, PUBLISH_LIMITS, callbackUrl, challengeMatches, retryDecision } from './policy.ts'

// Webhook deliveries of the Events goblin publishes (ADR 0112): each one signed with Standard Webhooks v1 (goblin's
// own `sign`, `mcp/events/webhook.ts`) at a fresh timestamp, POSTed through the `PublishFetch` port with no redirect,
// a five-second timeout and a bounded answer, outside any transaction, then settled under its claim.

/** How a webhook leaves the agent: `fetch` in production; the harness points it at its own receiver. */
export type PublishFetch = (url: string, init: RequestInit) => Promise<Response>

/** A lease's secret as sealed: bound to its lease. */
export const secretAad = (lease: string): string => `publish:${lease}:secret`

/** What one POST came to: the receiver's status and answer, or why it did not answer. */
export type Sent =
  | { readonly status: number; readonly body: Uint8Array }
  | { readonly status?: undefined; readonly reason: CallbackReason }

/** At most `PUBLISH_LIMITS.bodyBytes` of an answer; a longer one is `undefined`. */
async function boundedBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength
      if (size > PUBLISH_LIMITS.bodyBytes) return undefined
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const received = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    received.set(chunk, offset)
    offset += chunk.byteLength
  }
  return received
}

/** A webhook for one lease: where, its `webhook-id`, the lease's id, the exact body and the secret to sign with. */
export type Webhook = {
  readonly url: string
  readonly webhookId: string
  readonly subscriptionId: string
  readonly body: string
  readonly secret: string
}

/** One POST of `webhook`, its URL checked again first; never a redirect followed or an answer read past the bound. */
export const post = (send: PublishFetch, webhook: Webhook): Effect.Effect<Sent> =>
  Effect.gen(function* () {
    const url = yield* attemptSync(() => callbackUrl(webhook.url))
    const bytes = new TextEncoder().encode(webhook.body)
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    const signature = yield* attempt(() => sign(webhook.secret, webhook.webhookId, timestamp, bytes))
    const headers = {
      'content-type': 'application/json',
      'webhook-id': webhook.webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': webhook.subscriptionId,
    }
    const sent = Effect.tryPromise({
      try: async (signal): Promise<Sent> => {
        const timeout = AbortSignal.timeout(PUBLISH_LIMITS.timeoutMs)
        const response = await send(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.any([signal, timeout]),
          headers,
          body: bytes,
        })
        const body = await boundedBody(response.body)
        return body === undefined ? { status: 413, body: new Uint8Array(0) } : { status: response.status, body }
      },
      catch: (cause): Sent => ({
        reason: cause instanceof DOMException && cause.name === 'TimeoutError' ? 'timeout' : 'connection_refused',
      }),
    })
    // expected: a POST that did not reach the receiver is an answer too: why it did not.
    return yield* Effect.catch(sent, (failed) => Effect.succeed(failed))
  }).pipe(
    // expected: a URL the policy refuses now, or a secret that cannot sign, is a delivery that can never go out.
    Effect.catch(() => Effect.succeed<Sent>({ status: 410, body: new Uint8Array(0) })),
  )

/**
 * The signed verification challenge a new lease's URL must answer (ADR 0112), sent before the lease is kept and outside
 * any transaction: `{"type":"verification","challenge":…}` as `msg_verification_<random>`, answered 200 with the
 * challenge echoed as `{"challenge":…}`.
 */
export const challenge = (
  send: PublishFetch,
  lease: { readonly url: string; readonly subscriptionId: string; readonly secret: string },
  newId: Effect.Effect<string, AppError>,
): Effect.Effect<boolean, AppError> =>
  Effect.gen(function* () {
    const value = yield* newId
    const sent = yield* post(send, {
      ...lease,
      webhookId: `msg_verification_${yield* newId}`,
      body: JSON.stringify({ type: 'verification', challenge: value }),
    })
    return sent.status === 200 && challengeMatches(sent.body, value)
  })

/** What a drain needs: the database, the cipher the secrets are sealed with, the way out and fresh ids. */
export type DrainPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly cipher: CredentialCipher
  readonly send: PublishFetch
  readonly newId: Effect.Effect<string, AppError>
}

/** How many deliveries one round of a drain claims, and sends at once. */
const ROUND = 32
const AT_ONCE = 4

/** One claimed delivery sent and settled. */
const deliver = (ports: DrainPorts, row: Claimed, token: string) =>
  Effect.gen(function* () {
    const secret = yield* attempt(() => ports.cipher.decrypt(row.secret, secretAad(row.subscriptionId)))
    const sent = yield* post(ports.send, {
      url: row.url,
      webhookId: row.webhookId,
      subscriptionId: row.subscriptionId,
      body: row.body,
      secret,
    })
    const now = yield* Clock.currentTimeMillis
    const jitter = yield* Random.next
    const decision = retryDecision({
      status: sent.status,
      reason: 'reason' in sent ? sent.reason : undefined,
      attempts: row.attempts + 1,
      firstAttemptMs: row.firstAt,
      nowMs: now,
      jitter,
    })
    yield* Effect.sync(() => settle(ports.db, row, token, decision, now))
  }).pipe(reportAndRecover('publish.deliver', undefined))

/** Every delivery due now, round after round until none is: each claimed, sent outside a transaction, then settled. */
export const drain = (ports: DrainPorts): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const token = yield* ports.newId
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* Effect.sync(() => claimDue(ports.db, now, token, ROUND))
      if (rows.length === 0) return
      yield* Effect.forEach(rows, (row) => deliver(ports, row, token), { concurrency: AT_ONCE, discard: true })
    }
  })
