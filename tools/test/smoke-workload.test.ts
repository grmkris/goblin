import * as Redacted from 'effect/Redacted'
import { describe, expect, it } from 'vitest'
import { redirectMismatch } from '../../scripts/smoke-integrator.ts'
import { codeOf, NO_MAILBOX, sessionCookieOf, signInPlan } from '../../scripts/smoke-signin.ts'
import {
  JWT_BEARER,
  exchangeForm,
  oidcTokenUrl,
  rpcBody,
  toolValue,
  workloadMissing,
} from '../../scripts/smoke-workload.ts'

const MYSI = 'https://mysi.example'
const configured = {
  origin: MYSI,
  clientId: 'wl_smoke',
  requestUrl: 'https://token.actions.example/request?api-version=2.0',
  requestToken: Redacted.make('request-token'),
}

describe('a mysi workload (ADR 0128)', () => {
  it("asks GitHub for a token whose audience is mysi's token endpoint, keeping the request's own query", () => {
    const url = oidcTokenUrl(configured.requestUrl, MYSI)
    expect(url.searchParams.get('audience')).toBe(`${MYSI}/api/auth/oauth2/token`)
    expect(url.searchParams.get('api-version')).toBe('2.0')
  })

  it("exchanges the job's token as a jwt-bearer assertion for the policy's client, for mysi's /mcp", () => {
    expect(Object.fromEntries(exchangeForm(MYSI, 'wl_smoke', 'header.claims.signature'))).toEqual({
      grant_type: JWT_BEARER,
      assertion: 'header.claims.signature',
      client_id: 'wl_smoke',
      resource: `${MYSI}/mcp`,
    })
  })

  it('says why it cannot run: no policy configured, or no OIDC request in this job', () => {
    expect(workloadMissing(configured)).toBeUndefined()
    expect(workloadMissing({ ...configured, clientId: '' })).toBe('no workload configured')
    expect(workloadMissing({ ...configured, requestUrl: '' })).toBe('no OIDC token in this job')
    expect(workloadMissing({ ...configured, requestToken: Redacted.make('') })).toBe('no OIDC token in this job')
  })

  it("reads a JSON answer, or an SSE answer's last data line", () => {
    expect(rpcBody('application/json', '{"result":{"a":1}}')).toEqual({ result: { a: 1 } })
    const sse = 'event: message\ndata: {"result":{"a":1}}\n\ndata: {"result":{"a":2}}\n\n'
    expect(rpcBody('text/event-stream', sse)).toEqual({ result: { a: 2 } })
    expect(rpcBody('text/event-stream', ': keep-alive\n')).toEqual({})
  })

  it("takes a tool's structured content, else its first text part read as JSON", () => {
    expect(toolValue({ structuredContent: { cursor: 'c1' }, content: [] })).toEqual({ cursor: 'c1' })
    expect(toolValue({ content: [{ type: 'text', text: '{"cursor":"c2"}' }] })).toEqual({ cursor: 'c2' })
    expect(toolValue({ structuredContent: {}, content: [] })).toEqual({})
  })
})

describe("the smoke's sign-in (ADR 0128)", () => {
  const plan = { stage: 'dev', email: 'checks@example.com', sessionFile: '', workload: configured }

  it('signs in by email code once the account and the workload are configured and the job has OIDC', () => {
    expect(signInPlan(plan)).toEqual({ kind: 'email' })
  })

  it('says why it cannot sign in, so the release can tell unconfigured from broken', () => {
    expect(signInPlan({ ...plan, email: '' })).toEqual({
      kind: 'none',
      reason: `${NO_MAILBOX} (no test account configured)`,
    })
    expect(signInPlan({ ...plan, workload: { ...configured, clientId: '' } })).toEqual({
      kind: 'none',
      reason: `${NO_MAILBOX} (no workload configured)`,
    })
    expect(signInPlan({ ...plan, workload: { ...configured, requestUrl: '' } })).toEqual({
      kind: 'none',
      reason: `${NO_MAILBOX} (no OIDC token in this job)`,
    })
  })

  it('uses a saved session file against the local stack only', () => {
    expect(signInPlan({ ...plan, stage: 'local', sessionFile: '/tmp/s.json' })).toEqual({ kind: 'session' })
    expect(signInPlan({ ...plan, sessionFile: '/tmp/s.json' })).toEqual({ kind: 'email' })
  })

  it('finds the six-digit code a wait returned, and the cursor to wait from when none came', () => {
    const message = { codes: [{ value: 'goblin' }, { value: '123456' }] }
    expect(codeOf({ cursor: 'c3', message })).toEqual({ code: '123456', cursor: 'c3' })
    expect(codeOf({ cursor: 'c4' })).toEqual({ cursor: 'c4' })
    expect(codeOf({ cursor: 'c5', message: { codes: [{ value: '12345' }] } })).toEqual({ cursor: 'c5' })
    expect(codeOf('nothing')).toEqual({})
  })

  it('keeps only the session cookies a sign-in set', () => {
    expect(
      sessionCookieOf([
        '__Secure-better-auth.session_token=abc; Path=/; HttpOnly; Secure',
        '__Secure-better-auth.session_data=xyz; Path=/',
        'better-auth.session_token=def; Path=/',
      ]),
    ).toBe('__Secure-better-auth.session_token=abc; better-auth.session_token=def')
    expect(sessionCookieOf([])).toBe('')
  })
})

describe("an install's redirect (ADR 0118)", () => {
  const back = 'https://example.com/goblin-smoke/installed'

  it('carries what it must, back to the return URL', () => {
    expect(redirectMismatch(`${back}?installation=i1&workspace=w&state=s`, { installation: 'i1', state: 's' })).toBe('')
    expect(redirectMismatch(`${back}?error=access_denied&state=s`, { error: 'access_denied', state: 's' })).toBe('')
  })

  it('names what is wrong, never the values', () => {
    expect(redirectMismatch(undefined, {})).toBe('no redirect')
    expect(redirectMismatch('https://elsewhere.example/?state=s', { state: 's' })).toBe('redirect elsewhere')
    expect(redirectMismatch(`${back}?state=t`, { state: 's', workspace: 'w' })).toBe('redirect state, workspace')
  })
})
