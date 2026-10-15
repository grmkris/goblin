import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnv } from '../src/env.ts'
import { handleAuth } from '../src/auth/index.ts'
import { oidcProviderOf, refuseUnverifiedOidcUser } from '../src/auth/oidc.ts'
import { healthOf } from '../src/http/health.ts'

// Sign-in through an OpenID Connect provider (ADR 0064), end to end through Better Auth over the real auth schema in
// node:sqlite, against a provider played here: its discovery document, signing keys and token endpoint answer the
// Worker's own fetches. Nothing else is stood in for.

const APP = 'https://goblin.test'
const ISSUER = 'https://id.example'
const CLIENT = 'goblin-client'
const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)

/** The auth store as the migrations make it. */
function authStore(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const name of readdirSync(DIR)
    .filter((file) => file.endsWith('.sql'))
    .toSorted())
    db.exec(readFileSync(join(DIR, name), 'utf8'))
  return db
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const json64 = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)))

/** Who the provider says signs in: their subject, email, and whether it vouches for the email. */
type Person = { readonly sub: string; readonly email: string; readonly verified: boolean }

/**
 * The provider: discovery, an ES256 signing key, and a token endpoint that answers the code it issued with an ID token
 * for `person`, bound to the nonce the authorization asked for. Its log lists the token requests it took.
 */
async function provider(person: () => Person) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  if (!('privateKey' in keys)) throw new Error('ECDSA makes a key pair')
  const exported = await crypto.subtle.exportKey('jwk', keys.publicKey)
  if (exported instanceof ArrayBuffer) throw new Error('a JWK export is a key, not bytes')
  const jwk = { ...exported, kid: 'k1', alg: 'ES256', use: 'sig' }
  const nonces = new Map<string, string>()
  const tokens: URLSearchParams[] = []
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${json64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${json64(claims)}`
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  const answer = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    if (url.pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ['ES256'],
      })
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
    if (url.pathname === '/token') {
      const body = init?.body
      const form = new URLSearchParams(typeof body === 'string' || body instanceof URLSearchParams ? body : '')
      tokens.push(form)
      const now = Math.floor(Date.now() / 1000)
      const who = person()
      const idToken = await sign({
        iss: ISSUER,
        aud: CLIENT,
        sub: who.sub,
        email: who.email,
        email_verified: who.verified,
        nonce: nonces.get(form.get('code') ?? ''),
        iat: now,
        exp: now + 300,
      })
      return Response.json({
        access_token: 'provider-access',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      })
    }
    return new Response('not found', { status: 404 })
  }
  return {
    tokens,
    /** The code the provider gives back for an authorization request. */
    authorize: (authorization: URL): string => {
      const code = crypto.randomUUID()
      nonces.set(code, authorization.searchParams.get('nonce') ?? '')
      return code
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== ISSUER) throw new Error(`unexpected fetch to ${url.origin}`)
      return answer(url, init)
    },
  }
}

/**
 * The deployment, with its provider, sign-up mode and the store, as the Worker's env (the other tests' untyped record):
 * Better Auth reads the store through its own node:sqlite dialect, and the provider's routes reach no D1-only code
 * (the emailed-code cooldown is the one that does) and no other binding.
 */
const deployment = (db: DatabaseSync, settings: Partial<RuntimeEnv> = {}): RuntimeEnv =>
  Object.assign(Object.create(null), {
    APP_URL: APP,
    BETTER_AUTH_SECRET: 'oidc-test-secret-0123456789abcdef0123456789abcdef',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT,
    OIDC_CLIENT_SECRET: 'provider-secret',
    OIDC_LABEL: 'Sign in with Example',
    SIGNUP_MODE: 'open',
    AUTH_DB: db,
    ...settings,
  })

const Authorization = Schema.Struct({ url: Schema.String })

/** The cookies a response sets, as the next request sends them. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

/** A browser starting a sign-in, then the provider sending it back with a code; where it lands, and its cookies. */
async function signIn(env: RuntimeEnv, idp: Awaited<ReturnType<typeof provider>>, invite?: string) {
  const start = await handleAuth(
    new Request(`${APP}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: {
        origin: APP,
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        ...(invite === undefined ? {} : { 'x-invite-code': invite }),
      },
      body: JSON.stringify({
        provider: 'oidc',
        callbackURL: '/',
        newUserCallbackURL: '/start/welcome',
        errorCallbackURL: '/login',
        disableRedirect: true,
        // What a browser may not decide for itself: the Worker sets both.
        requestSignUp: true,
        scopes: ['offline_access'],
      }),
    }),
    env,
  )
  expect(start.status).toBe(200)
  const authorization = new URL(Schema.decodeUnknownSync(Authorization)(await start.json()).url)
  const code = idp.authorize(authorization)
  const state = authorization.searchParams.get('state') ?? ''
  const back = await handleAuth(
    new Request(`${APP}/api/auth/callback/oidc?code=${code}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiesOf(start), 'cf-connecting-ip': '203.0.113.7' },
    }),
    env,
  )
  return { authorization, back, location: back.headers.get('location') ?? '', cookies: cookiesOf(back) }
}

const count = (db: DatabaseSync, sql: string, ...params: string[]): number =>
  Number(db.prepare(sql).get(...params)?.['n'] ?? 0)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sign-in through the deployment provider (Better Auth over the auth schema)', () => {
  it('asks for an authorization with PKCE, a nonce and the three scopes, then makes a verified account', async () => {
    let person: Person = { sub: 'sub-1', email: 'new@example.com', verified: true }
    const idp = await provider(() => person)
    vi.stubGlobal('fetch', idp.fetch)
    const db = authStore()
    const { authorization, location, cookies } = await signIn(deployment(db), idp)
    expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`)
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: `${APP}/api/auth/callback/oidc`,
      code_challenge_method: 'S256',
    })
    expect(authorization.searchParams.get('scope')?.split(' ').toSorted()).toEqual(['email', 'openid', 'profile'])
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/u)
    expect(authorization.searchParams.get('nonce')).not.toBeNull()
    expect(idp.tokens[0]?.get('code_verifier')).toMatch(/^[\w~.-]{43,128}$/u)
    expect(location).toBe('/start/welcome')
    expect(cookies).toContain('session_token=')
    expect(count(db, 'SELECT COUNT(*) AS n FROM user WHERE email = ? AND emailVerified = 1', person.email)).toBe(1)
    // goblin keeps none of the provider's tokens.
    expect(
      db.prepare('SELECT accessToken, refreshToken, idToken FROM account WHERE providerId = ?').all('oidc'),
    ).toEqual([{ accessToken: null, refreshToken: null, idToken: null }])
    // The same subject signs in again to the same account, now an existing one.
    person = { ...person, email: 'renamed@example.com' }
    expect((await signIn(deployment(db), idp)).location).toBe('/')
    expect(count(db, 'SELECT COUNT(*) AS n FROM user')).toBe(1)
  })

  it('makes an account only as an emailed code may: not while closed, by invite with the code', async () => {
    const person: Person = { sub: 'sub-2', email: 'invited@example.com', verified: true }
    const idp = await provider(() => person)
    vi.stubGlobal('fetch', idp.fetch)
    const db = authStore()
    expect((await signIn(deployment(db, { SIGNUP_MODE: 'closed' }), idp)).location).toBe('/login?error=signup_disabled')
    const invite = deployment(db, { SIGNUP_MODE: 'invite', SIGNUP_INVITE_CODE: 'let-me-in' })
    expect((await signIn(invite, idp, 'wrong')).location).toBe('/login?error=signup_disabled')
    expect(count(db, 'SELECT COUNT(*) AS n FROM user')).toBe(0)
    expect((await signIn(invite, idp, 'let-me-in')).location).toBe('/start/welcome')
    // An existing account signs in while sign-up is closed.
    expect((await signIn(deployment(db, { SIGNUP_MODE: 'closed' }), idp)).location).toBe('/')
  })

  it('makes no account for an email the provider has not verified', async () => {
    const idp = await provider(() => ({ sub: 'sub-3', email: 'claimed@example.com', verified: false }))
    vi.stubGlobal('fetch', idp.fetch)
    const db = authStore()
    const { location, cookies } = await signIn(deployment(db), idp)
    expect(location).toMatch(/^\/login\?error=email_not_verified/u)
    expect(cookies).not.toContain('session_token=')
    expect(count(db, 'SELECT COUNT(*) AS n FROM user')).toBe(0)
  })

  it('joins an existing account only when the provider verifies its email', async () => {
    let verified = false
    const idp = await provider(() => ({ sub: 'sub-4', email: 'owner@example.com', verified }))
    vi.stubGlobal('fetch', idp.fetch)
    const db = authStore()
    const now = new Date().toISOString()
    db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(
      'u1',
      '',
      'owner@example.com',
      now,
      now,
    )
    expect((await signIn(deployment(db), idp)).location).toBe('/login?error=account_not_linked')
    expect(count(db, 'SELECT COUNT(*) AS n FROM account WHERE userId = ?', 'u1')).toBe(0)
    verified = true
    expect((await signIn(deployment(db), idp)).location).toBe('/')
    expect(count(db, 'SELECT COUNT(*) AS n FROM account WHERE userId = ? AND providerId = ?', 'u1', 'oidc')).toBe(1)
  })

  it("answers 404 without a provider, for another provider's name, and 400 for an ID token of the browser's", async () => {
    const db = authStore()
    const post = (env: RuntimeEnv, body: Record<string, unknown>) =>
      handleAuth(
        new Request(`${APP}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { origin: APP, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' },
          body: JSON.stringify({ callbackURL: '/', ...body }),
        }),
        env,
      )
    const none = deployment(db, { OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' })
    expect((await post(none, { provider: 'oidc' })).status).toBe(404)
    expect((await handleAuth(new Request(`${APP}/api/auth/callback/oidc?code=x&state=y`), none)).status).toBe(404)
    expect((await post(deployment(db), { provider: 'github' })).status).toBe(404)
    expect((await post(deployment(db), { provider: 'oidc', idToken: { token: 'forged' } })).status).toBe(400)
  })
})

describe('the provider settings and what /health says (unit)', () => {
  it('needs the issuer, client id and secret together, and labels the button by the issuer without words', () => {
    const env = { OIDC_ISSUER: 'https://id.example/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' }
    expect(oidcProviderOf(env)).toEqual({
      issuer: 'https://id.example',
      clientId: 'c',
      clientSecret: 's',
      label: 'Sign in with id.example',
    })
    expect(oidcProviderOf({ ...env, OIDC_LABEL: ' Sign in with mysi ' })?.label).toBe('Sign in with mysi')
    expect(oidcProviderOf({ ...env, OIDC_CLIENT_SECRET: '' })).toBeUndefined()
    expect(oidcProviderOf({ ...env, OIDC_ISSUER: 'not a url' })).toBeUndefined()
  })

  it('lists an emailed code only with mail, the provider only when set, and keeps the stage a label', () => {
    const db = authStore()
    const mail = { MAIL: { send: () => Promise.resolve(undefined) }, MAIL_SENDER: 'hello@goblin.test' }
    expect(healthOf(deployment(db, { STAGE: 'dev', SIGNUP_MODE: 'invite', ...mail }))).toEqual({
      ok: true,
      service: 'goblin',
      stage: 'dev',
      signup: 'invite',
      signIn: [{ method: 'email' }, { method: 'oidc', label: 'Sign in with Example' }],
    })
    expect(healthOf(deployment(db, { OIDC_CLIENT_SECRET: '' })).signIn).toEqual([])
  })

  it('refuses only a new account from the provider whose email it has not verified', () => {
    const create = { action: 'create-user', method: 'oauth', oauth: { providerId: 'oidc' } }
    expect(refuseUnverifiedOidcUser({ user: { emailVerified: false }, source: create })).toMatchObject({
      error: 'email_not_verified',
    })
    expect(refuseUnverifiedOidcUser({ user: { emailVerified: true }, source: create })).toBeUndefined()
    expect(
      refuseUnverifiedOidcUser({
        user: { emailVerified: false },
        source: { action: 'create-user', method: 'email-otp' },
      }),
    ).toBeUndefined()
    expect(
      refuseUnverifiedOidcUser({ user: { emailVerified: false }, source: { ...create, action: 'sign-in' } }),
    ).toBeUndefined()
  })
})
