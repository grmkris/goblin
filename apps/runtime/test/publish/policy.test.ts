import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { decodeEnvelope, verifyWebhook } from '../../src/mcp/events/webhook.ts'
import { challenge, post } from '../../src/publish/deliver.ts'
import {
  PUBLISH_LIMITS,
  callbackUrl,
  canonicalJson,
  challengeMatches,
  leaseMs,
  retryDecision,
  subscriptionId,
  webhookSecret,
} from '../../src/publish/policy.ts'

const SECRET = `whsec_${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`
let ids = 0
const newId = Effect.sync(() => `id-${(ids += 1)}`)

/** The lease id of `holder`, `args` and `url`. */
const id = (holder: string, args: unknown, url = 'https://hooks.example.com/a') =>
  subscriptionId(holder, { name: 'conversation.updated', arguments: args }, url)

/** The decision after attempt `attempts` that answered `status` at `at`, the first attempt at 0. */
const decide = (attempts: number, status?: number, at = 0) =>
  retryDecision({ status, attempts, firstAttemptMs: 0, nowMs: at, jitter: 0.5 })

/** A receiver that records each POST and answers with `answer`. */
const receiver = (answer: (request: Request) => Response | Promise<Response>) => {
  const seen: Request[] = []
  const send = async (url: string, init: RequestInit) => {
    const request = new Request(url, init)
    seen.push(request.clone())
    return answer(request)
  }
  return { seen, send }
}

describe('the callback URL a lease may name (ADR 0112)', () => {
  it('takes a public https URL exactly as written', () => {
    expect(callbackUrl('https://hooks.example.com/goblin?x=1')).toBe('https://hooks.example.com/goblin?x=1')
  })

  it('refuses http, a port, credentials, a fragment, an IP literal, a bare or local name and an unnormalized URL', () => {
    for (const url of [
      'http://hooks.example.com/goblin',
      'https://hooks.example.com:8443/goblin',
      'https://user:pass@hooks.example.com/goblin',
      'https://hooks.example.com/goblin#frag',
      'https://127.0.0.1/goblin',
      'https://[::1]/goblin',
      'https://localhost/goblin',
      'https://receiver.test/goblin',
      'https://box.local/goblin',
      'https://svc.internal/goblin',
      'https://hooks.example.com.',
      'https://HOOKS.example.com/goblin',
      'not a url',
    ])
      expect(() => callbackUrl(url), url).toThrow(expect.objectContaining({ reason: 'event_callback_url' }))
  })
})

describe('a lease', () => {
  it('takes a whsec_ secret of 24 to 64 bytes only', () => {
    expect(webhookSecret(SECRET)).toBe(SECRET)
    const short = `whsec_${btoa('x'.repeat(23))}`
    const long = `whsec_${btoa('x'.repeat(65))}`
    for (const secret of [short, long, 'whsec_!!!!', SECRET.slice(6), `whsec_${'A'.repeat(33)}`])
      expect(() => webhookSecret(secret), secret).toThrow(expect.objectContaining({ reason: 'event_secret' }))
  })

  it('lasts an hour unless asked otherwise, never under five minutes or over a day', () => {
    expect(leaseMs(undefined)).toBe(3_600_000)
    expect(leaseMs(null)).toBe(3_600_000)
    expect(leaseMs(1000)).toBe(300_000)
    expect(leaseMs(10 * 86_400_000)).toBe(86_400_000)
    expect(leaseMs(7_200_000)).toBe(7_200_000)
  })

  it('has one id per holder, URL and canonical selector', async () => {
    expect(await id('key:k1', { topic: '2' })).toBe(await id('key:k1', { topic: '2' }))
    expect(await id('key:k1', { topic: '2' })).toMatch(/^sub_[0-9a-f]{64}$/u)
    expect(await id('key:k2', { topic: '2' })).not.toBe(await id('key:k1', { topic: '2' }))
    expect(await id('key:k1', { topic: '3' })).not.toBe(await id('key:k1', { topic: '2' }))
    expect(await id('key:k1', {}, 'https://hooks.example.com/b')).not.toBe(await id('key:k1', {}))
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 0 } })).toBe('{"a":{"c":0,"d":[2,1]},"b":1}')
  })
})

describe('retries (myapps eventRetryDecision)', () => {
  it('accepts a 2xx and gives up on a redirect, 410 or 413 at once', () => {
    expect(decide(1, 204).state).toBe('accepted')
    for (const status of [301, 307, 410, 413]) expect(decide(1, status).state, String(status)).toBe('abandoned')
  })

  it('tries again 15 s·2ⁿ later, at most five minutes, and gives up after the fifth attempt', () => {
    expect(decide(1, 500)).toEqual({ state: 'retry', atMs: 15_000, reason: 'http_5xx' })
    expect(decide(2, 503)).toMatchObject({ state: 'retry', atMs: 30_000 })
    expect(decide(3, 429)).toMatchObject({ state: 'retry', atMs: 60_000, reason: 'http_4xx' })
    expect(decide(4, 500)).toMatchObject({ state: 'retry', atMs: 120_000 })
    expect(decide(5, 500).state).toBe('abandoned')
    expect(retryDecision({ reason: 'timeout', attempts: 1, firstAttemptMs: 0, nowMs: 0, jitter: 0 })).toEqual({
      state: 'retry',
      atMs: 11_250,
      reason: 'timeout',
    })
    expect(decide(2, 500, PUBLISH_LIMITS.retryWindowMs).state).toBe('abandoned')
  })
})

describe('a signed webhook', () => {
  it('signs the exact body at a fresh timestamp, which goblin’s own consumer verifies and decodes', async () => {
    const { seen, send } = receiver(() => new Response(null, { status: 204 }))
    const body = JSON.stringify({
      eventId: 'evt-1',
      name: 'conversation.updated',
      timestamp: '2026-10-22T10:00:00.000Z',
      data: { chat: '7', topic: '2', entry: 12, activity: 'idle', attention: 0 },
      cursor: '0000000000000003',
    })
    const sent = await Effect.runPromise(
      post(send, {
        url: 'https://hooks.example.com/a',
        webhookId: 'evt-1',
        subscriptionId: 'sub_1',
        body,
        secret: SECRET,
      }),
    )
    expect(sent.status).toBe(204)
    const [request] = seen
    if (request === undefined) throw new Error('nothing sent')
    expect(request.redirect).toBe('manual')
    const headers = {
      id: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
    }
    expect(headers.id).toBe('evt-1')
    expect(request.headers.get('x-mcp-subscription-id')).toBe('sub_1')
    const bytes = new Uint8Array(await request.arrayBuffer())
    expect(new TextDecoder().decode(bytes)).toBe(body)
    await verifyWebhook(SECRET, headers, bytes, Date.now())
    expect(decodeEnvelope(bytes, headers.id)).toMatchObject({ eventId: 'evt-1', data: { chat: '7' } })
    await expect(verifyWebhook(`whsec_${btoa('y'.repeat(32))}`, headers, bytes, Date.now())).rejects.toThrow()
  })

  it('answers why a POST did not arrive, and never goes to a URL the policy refuses', async () => {
    const down = receiver(() => Promise.reject(new TypeError('refused')))
    const webhook = { webhookId: 'evt-2', subscriptionId: 'sub_1', body: '{}', secret: SECRET }
    expect(await Effect.runPromise(post(down.send, { ...webhook, url: 'https://hooks.example.com/a' }))).toEqual({
      reason: 'connection_refused',
    })
    const local = receiver(() => new Response(null, { status: 204 }))
    expect((await Effect.runPromise(post(local.send, { ...webhook, url: 'http://hooks.example.com/a' }))).status).toBe(
      410,
    )
    expect(local.seen).toEqual([])
  })

  it('verifies a lease by a signed challenge the URL must echo', async () => {
    const lease = { url: 'https://hooks.example.com/a', subscriptionId: 'sub_1', secret: SECRET }
    const echo = receiver(async (request) => {
      const bytes = new Uint8Array(await request.arrayBuffer())
      const envelope = decodeEnvelope(bytes, request.headers.get('webhook-id') ?? '')
      return Response.json('challenge' in envelope ? { challenge: envelope.challenge } : {})
    })
    expect(await Effect.runPromise(challenge(echo.send, lease, newId))).toBe(true)
    expect(echo.seen[0]?.headers.get('webhook-id')).toMatch(/^msg_verification_/u)
    const wrong = receiver(() => Response.json({ challenge: 'not it' }))
    expect(await Effect.runPromise(challenge(wrong.send, lease, newId))).toBe(false)
    expect(challengeMatches(new TextEncoder().encode('{"challenge":"abc"}'), 'abc')).toBe(true)
    expect(challengeMatches(new TextEncoder().encode('{"challenge":"abd"}'), 'abc')).toBe(false)
  })
})
