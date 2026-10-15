import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import {
  AuthRefused,
  healthQuery,
  requestSignInCode,
  signInWithProvider,
  signOutMutation,
} from '../src/auth/queries.ts'
import { messageOf } from '../src/lib/query/app-error.ts'
import { testQueryClient } from '../src/lib/query/testing.ts'

/** A fetch that answers every request with `response` and keeps what was sent. */
const answerer = (response: () => Response) => {
  const sent: Request[] = []
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input instanceof Request ? input : new URL(String(input), 'http://app.test'), init))
    return response()
  }
  return { sent, send }
}

/** The browser's fetch answering every request with `response`; what was sent. */
const answering = (response: () => Response) => {
  const { sent, send } = answerer(response)
  vi.stubGlobal('fetch', send)
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the public health', () => {
  it('reads the sign-up mode and the ways to sign in, and anything unsaid as off', async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    answering(() =>
      Response.json({
        ok: true,
        signup: 'invite',
        signIn: [{ method: 'email' }, { method: 'oidc', label: 'Sign in with mysi' }],
      }),
    )
    expect(await testQueryClient().query(healthQuery)).toEqual({
      signup: 'invite',
      methods: { email: true, oidc: { label: 'Sign in with mysi' } },
    })
    answering(() => Response.json({ ok: true, signup: 'open', signIn: [{ method: 'oidc', label: 'Use Okta' }] }))
    expect(await testQueryClient().query(healthQuery)).toEqual({
      signup: 'open',
      methods: { email: false, oidc: { label: 'Use Okta' } },
    })
    answering(() => Response.json({ ok: true }))
    expect(await testQueryClient().query(healthQuery)).toEqual({ signup: 'closed', methods: { email: false } })
  })
})

describe("a sign-in through the deployment's provider", () => {
  it('names the provider, where it comes back to, the invite code, and answers where to go', async () => {
    vi.stubGlobal('location', new URL('http://app.test/login?new=1'))
    const { sent, send } = answerer(() =>
      Response.json({ url: 'https://id.example/authorize?state=s', redirect: false }),
    )
    expect(await signInWithProvider('let-me-in', '/login?new=1', send)).toBe('https://id.example/authorize?state=s')
    const [request] = sent
    expect(new URL(request?.url ?? '').pathname).toBe('/api/auth/sign-in/social')
    expect(request?.headers.get('x-invite-code')).toBe('let-me-in')
    expect(await request?.json()).toMatchObject({
      provider: 'oidc',
      callbackURL: '/',
      newUserCallbackURL: '/start/welcome',
      errorCallbackURL: '/login?new=1',
      disableRedirect: true,
    })
  })

  it('refuses an answer that names nowhere to go', async () => {
    vi.stubGlobal('location', new URL('http://app.test/login'))
    const { send } = answerer(() => Response.json({ redirect: false }))
    const failure = await signInWithProvider('', '/login', send).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ status: 502 })
  })
})

describe('a sign-in failure', () => {
  it("quotes the reference of the answer that refused it, Cloudflare's ray when the Worker stamped none", async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    const sent = answering(() =>
      Response.json({ error: 'busy' }, { status: 503, headers: { 'cf-ray': '8f1e2d3c4b5a6978-AMS' } }),
    )
    const failure = await testQueryClient()
      .query(healthQuery)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(failure).toMatchObject({ status: 503, ref: '8f1e2d3c4b5a6978-AMS' })
    expect(messageOf(failure, 'reach goblin')).toMatch(/^Could not reach goblin\. .+ · ref 8f1e2d3c$/u)
    expect(sent[0]?.headers.get('x-goblin-request')).toMatch(/^[0-9a-f]{8}$/u)
  })

  it('quotes the id it was sent with when nothing answered', async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const failure = await requestSignInCode('owner@example.com', '').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(failure).toMatchObject({ status: 503 })
    expect(failure instanceof AuthRefused ? failure.ref : '').toMatch(/^[0-9a-f]{8}$/u)
    expect(messageOf(failure, 'send a code')).toMatch(/ · ref [0-9a-f]{8}$/u)
  })

  it('a sign-out that fails is an AuthRefused, quoted like any other', async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    answering(() => Response.json({}, { status: 500 }))
    const failure = await new MutationObserver(testQueryClient(), signOutMutation).mutate().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(messageOf(failure, 'sign out')).toMatch(/^Could not sign out\. .+ · ref [0-9a-f]{8}$/u)
  })
})
