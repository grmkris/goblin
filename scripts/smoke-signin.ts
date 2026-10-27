/**
 * The smoke's sign-in as a person (ADR 0128): the stage emails the checks account a code, the code is read from its
 * mailbox through mysi trusted workloads (`smoke-workload.ts`), and the account signs in with it. The session cookie
 * lives in this process only: never written, never logged, gone when the smoke ends.
 */
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import type { DevClient } from './smoke-client.ts'
import { type Workload, type WorkloadConfig, workloadMissing } from './smoke-workload.ts'

/** What a smoke that cannot sign in records, with why (ADR 0128): the release accepts it while this is the reason. */
export const NO_MAILBOX = 'skipped: no mailbox access'

/** How a smoke signs in, or why it cannot here. */
export type SignInPlan =
  | { readonly kind: 'email' }
  | { readonly kind: 'session' }
  | { readonly kind: 'none'; readonly reason: string }

/**
 * How this run signs in: by email code through the mailbox workload when both the test account and the workload are
 * configured and the job can mint an OIDC token; with a saved session file only against the local stack; else not at
 * all, saying why.
 */
export function signInPlan(input: {
  readonly stage: string
  readonly email: string
  readonly sessionFile: string
  readonly workload: WorkloadConfig
}): SignInPlan {
  if (input.stage === 'local' && input.sessionFile !== '') return { kind: 'session' }
  if (input.email === '') return { kind: 'none', reason: `${NO_MAILBOX} (no test account configured)` }
  const missing = workloadMissing(input.workload)
  return missing === undefined ? { kind: 'email' } : { kind: 'none', reason: `${NO_MAILBOX} (${missing})` }
}

/** How long one mailbox wait may take (myinbox's `verification_wait` allows 0–50 s), and how many waits in all. */
const WAIT_SECONDS = 45
const WAITS = 2
/** The subject goblin's sign-in mail carries on every stage (`apps/runtime/src/auth/mail.ts`). */
const SUBJECT = 'goblin sign-in code'

const Waited = Schema.Struct({
  cursor: Schema.String,
  message: Schema.optional(
    Schema.Struct({ codes: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))) }),
  ),
})
const decodeWaited = Schema.decodeUnknownOption(Waited)
const Cursor = Schema.Struct({ cursor: Schema.String })

/** The six-digit code a `verification_wait` found, and the cursor to wait from next; no code when none came. */
export function codeOf(waited: unknown): { readonly code?: string; readonly cursor?: string } {
  const value = Option.getOrUndefined(decodeWaited(waited))
  if (value === undefined) return {}
  const code = value.message?.codes?.find((candidate) => /^\d{6}$/u.test(candidate.value))?.value
  return { cursor: value.cursor, ...(code === undefined ? {} : { code }) }
}

/** The session cookie a sign-in set: its `session_token` cookies as one `Cookie` header, or `''`. */
export const sessionCookieOf = (setCookies: readonly string[]): string =>
  setCookies
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => pair.includes('session_token='))
    .join('; ')

async function waitForCode(mailbox: Workload, address: string, cursor: string): Promise<string> {
  let from = cursor
  for (let attempt = 0; attempt < WAITS; attempt++) {
    const waited = codeOf(
      await mailbox.call('myinbox_verification_wait', {
        address,
        cursor: from,
        subject: SUBJECT,
        timeoutSeconds: WAIT_SECONDS,
      }),
    )
    if (waited.code !== undefined) return waited.code
    from = waited.cursor ?? from
  }
  throw new Error('signin_code_not_received')
}

/**
 * Signs `email` in on the stage `dev` talks to and keeps the session in `dev`, in the person's first workspace, which
 * listing them makes if there is none. The mailbox's cursor is taken before the code is sent, so an older code is never
 * read. The stage's invite code goes with both requests, so the first sign-in after a reset makes the account again.
 */
export async function signInByEmail(
  dev: DevClient,
  mailbox: Workload,
  email: string,
  inviteCode: Redacted.Redacted,
): Promise<void> {
  const { cursor } = Schema.decodeUnknownSync(Cursor)(await mailbox.call('myinbox_address_cursor', { address: email }))
  const invite = Redacted.value(inviteCode)
  const json = { 'content-type': 'application/json', ...(invite === '' ? {} : { 'x-invite-code': invite }) }
  const sent = await dev.send('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    owner: false,
    headers: json,
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  if (sent.status !== 200) throw new Error(`signin_code_not_sent: ${sent.status}`)
  const code = await waitForCode(mailbox, email, cursor)
  const signed = await dev.send('/api/auth/sign-in/email-otp', {
    method: 'POST',
    owner: false,
    headers: json,
    body: JSON.stringify({ email, otp: code }),
  })
  const cookie = sessionCookieOf(signed.headers.getSetCookie())
  if (signed.status !== 200 || cookie === '') throw new Error(`signin_refused: ${signed.status}`)
  await dev.useCookie(cookie, email)
}
