import { type ReactNode, useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  AlertDescription,
  type AuthActionResult,
  Button,
  EmailSignInForm,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ProviderSignIn,
  SignInDivider,
  Skeleton,
  failed,
  succeeded,
} from '@goblin/ui'
import { redirectOf } from '../lib/auth-client.ts'
import {
  AuthRefused,
  type SignInMethods,
  healthQuery,
  requestSignInCode,
  signInWithProvider,
  verifySignInCode,
} from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { AuthShell } from './auth-shell.tsx'

type SignupMode = 'open' | 'invite' | 'closed'
/** `failed`: `/health` could not be read, so how sign-in and sign-up work here is unknown, not off. */
type AuthConfig = {
  readonly signup: SignupMode
  readonly methods: SignInMethods
  readonly status: 'loading' | 'loaded' | 'failed'
  /** Why `/health` could not be read, with the reference to quote. */
  readonly failure: string
  readonly retry: () => void
}
const NO_METHODS: SignInMethods = { email: false }
function useAuthConfig(): AuthConfig {
  const read = useQuery(healthQuery)
  const { refetch } = read
  const retry = useCallback(() => void refetch(), [refetch])
  if (read.data !== undefined)
    return { signup: read.data.signup, methods: read.data.methods, status: 'loaded', failure: '', retry }
  const unread = read.isError && !read.isFetching
  return {
    signup: 'closed',
    methods: NO_METHODS,
    status: unread ? 'failed' : 'loading',
    failure: unread ? messageOf(read.error, 'reach goblin') : '',
    retry,
  }
}

/** The ways in this deployment offers, its provider first, or why there is none. */
function SignInBody({
  config,
  provider,
  form,
}: {
  readonly config: AuthConfig
  readonly provider: ReactNode
  readonly form: ReactNode
}) {
  if (config.status === 'loading')
    return (
      <div className="auth-body" aria-busy>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  if (config.status === 'failed')
    return (
      <div className="auth-body">
        <Alert variant="destructive">
          <AlertDescription>{config.failure}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={config.retry}>
          Try again
        </Button>
      </div>
    )
  const { email, oidc } = config.methods
  if (oidc === undefined && !email)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Sign-in is temporarily unavailable. Please try again later.
      </p>
    )
  if (oidc === undefined) return form
  return (
    <div className="auth-body">
      {provider}
      {email && <SignInDivider />}
      {email && form}
    </div>
  )
}
/** The refusals the form explains in its own words; anything else reads through messageOf. Each quotes its ref. */
const OWN_WORDS: Readonly<Record<number, string>> = {
  403: 'New accounts need a valid invite. Existing users can sign in.',
  429: 'Too many tries. Wait a minute and try again.',
}
/** Reports a refused step to the owner in the form, with the reference to quote. */
const reportRefusal = (error: unknown, action: string, words: Readonly<Record<number, string>> = {}) => {
  const status = error instanceof AuthRefused ? error.status : undefined
  const own = status === undefined ? undefined : (words[status] ?? OWN_WORDS[status])
  return failed(own === undefined ? messageOf(error, action) : withRef(own, error))
}
const CODE_REFUSED = {
  400: 'That code did not work. Check it or get a new one.',
  401: 'That code did not work. Check it or get a new one.',
}
function continueAfter(data: unknown, onAuthenticated: () => void): AuthActionResult {
  const next = redirectOf(data)
  if (next !== undefined && new URL(next, window.location.origin).pathname !== window.location.pathname)
    window.location.assign(next)
  else onAuthenticated()
  return succeeded
}
function codeActions(inviteCode: string, onAuthenticated: () => void) {
  return {
    onRequestCode: async (email: string): Promise<AuthActionResult> => {
      try {
        await requestSignInCode(email, inviteCode)
        return succeeded
      } catch (error) {
        return reportRefusal(error, 'send a code')
      }
    },
    onVerifyCode: async (email: string, otp: string): Promise<AuthActionResult> => {
      try {
        return continueAfter(await verifySignInCode(email, otp, inviteCode), onAuthenticated)
      } catch (error) {
        return reportRefusal(error, 'sign in with that code', CODE_REFUSED)
      }
    },
  }
}

/**
 * Leaves for the provider's sign-in. It comes back to this page, as it is now (an MCP client's authorization keeps its
 * signed query), with `error` when it did not finish.
 */
const providerAction = (inviteCode: string) => async (): Promise<AuthActionResult> => {
  try {
    window.location.assign(await signInWithProvider(inviteCode, window.location.pathname + window.location.search))
    return succeeded
  } catch (error) {
    return reportRefusal(error, 'start the sign-in')
  }
}

/** Why a provider's sign-in came back without one (Better Auth's `error`), in words the owner can act on. */
const PROVIDER_REFUSED: Readonly<Record<string, string>> = {
  signup_disabled: 'That account is not here yet. New accounts need a valid invite: choose Create an account.',
  account_not_linked:
    'An account with that email is already here. Sign in with an emailed code instead; your provider must confirm the email to join it.',
  email_not_verified: 'Your provider has not confirmed that email address, so it cannot make an account here.',
  access_denied: 'The sign-in was cancelled.',
}
export const providerRefusal = (error: string): string =>
  PROVIDER_REFUSED[error] ?? 'The sign-in did not finish. Try again.'

/**
 * Signing in, or creating an account (`creating` opens on it, as the landing's Meet your goblin asks): an account can
 * be created only where sign-up is open or by invite, so a deployment with sign-up closed shows sign-in once it says so.
 * The deployment's provider, when it has one, comes first; `providerError` is why its last sign-in came back without
 * one. `onAuthenticated` learns whether the owner signed in through creating an account.
 */
export function Authentication({
  onAuthenticated,
  creating: startCreating = false,
  providerError,
}: {
  readonly onAuthenticated: (created: boolean) => void
  readonly creating?: boolean
  readonly providerError?: string | undefined
}) {
  const config = useAuthConfig()
  const [inviteCode, setInviteCode] = useState('')
  const [wantsToCreate, setCreating] = useState(startCreating)
  const creating = wantsToCreate && !(config.status === 'loaded' && config.signup === 'closed')
  const invite = creating ? inviteCode : ''
  const label = config.methods.oidc?.label ?? ''
  return (
    <AuthShell
      title={creating ? 'Meet your goblin' : 'Sign in to goblin'}
      description="Your own resident agent, always on."
      footer={
        config.signup !== 'closed' && (
          <p>
            <button type="button" onClick={() => setCreating(!creating)}>
              {creating ? 'Back to sign in' : 'New here? Create an account'}
            </button>
          </p>
        )
      }
    >
      {providerError !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{providerRefusal(providerError)}</AlertDescription>
        </Alert>
      )}
      {creating && config.signup === 'invite' && (
        <Field>
          <FieldLabel htmlFor="invite-code">Invite code</FieldLabel>
          <Input
            id="invite-code"
            type="password"
            autoComplete="off"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <FieldDescription>goblin is invite-only for now.</FieldDescription>
        </Field>
      )}
      <SignInBody
        config={config}
        provider={
          <ProviderSignIn key={`${String(creating)}-provider`} label={label} onSignIn={providerAction(invite)} />
        }
        form={
          <EmailSignInForm key={String(creating)} emailCode={codeActions(invite, () => onAuthenticated(creating))} />
        }
      />
    </AuthShell>
  )
}
