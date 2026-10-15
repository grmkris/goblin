// Sign-in through the deployment's OpenID Connect provider (ADR 0064), beside emailed codes. Better Auth's generic
// OAuth plugin registers it as one more social provider, so it uses the core routes `/sign-in/social` and
// `/callback/oidc` under the auth base path; nothing it adds sits under the MCP provider's `/oauth2/*`.
import { OIDC_PROVIDER_ID as OIDC_PROVIDER } from '@goblin/contracts'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, type createAuthMiddleware } from 'better-auth/api'
import { genericOAuth } from 'better-auth/plugins'
import { Predicate } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { signupAllowed, signupMode } from './signup.ts'

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

// The provider's id names the callback route, `/api/auth/callback/oidc`, which the provider must allow.
const SIGN_IN = '/sign-in/social'
const CALLBACK = `/callback/${OIDC_PROVIDER}`
/** What goblin asks the provider for: who the person is and their email, nothing that reaches their data. */
const SCOPES = ['openid', 'email', 'profile']

type OidcEnvironment = Pick<RuntimeEnv, 'OIDC_ISSUER' | 'OIDC_CLIENT_ID' | 'OIDC_CLIENT_SECRET' | 'OIDC_LABEL'>

/** The provider as configured: its issuer, the client goblin is registered as, and the button's words. */
export type OidcProvider = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly label: string
}

/**
 * The deployment's OpenID Connect provider, when its issuer, client id and client secret are all set; none otherwise.
 * The label defaults to the issuer's host ("Sign in with id.example.com").
 */
export const oidcProviderOf = (env: OidcEnvironment): OidcProvider | undefined => {
  const issuer = env.OIDC_ISSUER?.trim().replace(/\/+$/u, '') ?? ''
  const clientId = env.OIDC_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.OIDC_CLIENT_SECRET ?? ''
  if (issuer === '' || clientId === '' || clientSecret === '' || !URL.canParse(issuer)) return undefined
  const label = env.OIDC_LABEL?.trim() ?? ''
  return { issuer, clientId, clientSecret, label: label === '' ? `Sign in with ${new URL(issuer).host}` : label }
}

/** Whether `path` (under the auth base path) is one of the provider's two routes, the only ones that need it built. */
export const isOidcPath = (path: string): boolean => path === SIGN_IN || path.startsWith('/callback/')

/**
 * The plugin for `provider`: discovery from the issuer, which must publish its signing keys (an ID token is always
 * verified), PKCE, the three scopes, and no sign-up unless the sign-in asked for one (`guardOidc` decides that).
 * Signing out of goblin leaves the provider's own session alone.
 */
export const oidcPlugin = (provider: OidcProvider): BetterAuthPlugin =>
  genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER,
        name: provider.label,
        discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`,
        requireIdTokenVerification: true,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        scopes: SCOPES,
        pkce: true,
        disableImplicitSignUp: true,
        disableProviderLogout: true,
      },
    ],
  })

/**
 * The gate before the provider's routes. Without a provider they do not exist. A sign-in must name the provider, may
 * not hand in an ID token of its own or ask for other scopes, and may make an account only as an emailed code may
 * (`SIGNUP_MODE`, the invite code in `x-invite-code`): the answer is set here, over whatever the browser sent, and the
 * callback reads it from the sign-in's stored state. Returns whether the path was one of the provider's.
 */
export function guardOidc(
  context: HookContext,
  env: Pick<RuntimeEnv, 'SIGNUP_MODE' | 'SIGNUP_INVITE_CODE'> & OidcEnvironment,
): boolean {
  const path = context.path ?? ''
  if (!isOidcPath(path)) return false
  if (oidcProviderOf(env) === undefined) throw new APIError('NOT_FOUND', { message: 'Not found' })
  if (path.startsWith('/callback/')) {
    if (path !== CALLBACK && context.params?.['id'] !== OIDC_PROVIDER)
      throw new APIError('NOT_FOUND', { message: 'Not found' })
    return true
  }
  const body: unknown = context.body
  if (!Predicate.isObject(body) || !Predicate.hasProperty(body, 'provider') || body.provider !== OIDC_PROVIDER)
    throw new APIError('NOT_FOUND', { message: 'Not found' })
  if (Predicate.hasProperty(body, 'idToken') && body.idToken !== undefined)
    throw new APIError('BAD_REQUEST', { message: 'Invalid request' })
  const presented = context.headers?.get('x-invite-code') ?? ''
  Object.assign(body, {
    scopes: undefined,
    requestSignUp: signupAllowed(signupMode(env.SIGNUP_MODE), env.SIGNUP_INVITE_CODE ?? '', presented),
  })
  return true
}

/**
 * What a provider's account may not do on the way in: make a goblin account for an email the provider has not
 * verified. Otherwise anyone could claim an address at a lax provider, and its owner, signing in later by code, would
 * land in an account the claimant can still reach. Linking to an existing account already needs a verified email
 * (Better Auth's account linking, which this deployment trusts no provider past).
 */
export const refuseUnverifiedOidcUser = (data: {
  readonly user: { readonly emailVerified?: unknown }
  readonly source: {
    readonly action: string
    readonly method: string
    readonly oauth?: { readonly providerId: string } | undefined
  }
}): { readonly error: string; readonly errorDescription: string } | undefined =>
  data.source.action === 'create-user' &&
  data.source.method === 'oauth' &&
  data.source.oauth?.providerId === OIDC_PROVIDER &&
  data.user.emailVerified !== true
    ? { error: 'email_not_verified', errorDescription: 'The provider has not verified this email address.' }
    : undefined

/** An account row with the provider's tokens left out: goblin signs in with the provider and never calls it after. */
export const withoutProviderTokens = <Account extends object>(account: Account) => ({
  ...account,
  accessToken: undefined,
  refreshToken: undefined,
  idToken: undefined,
  accessTokenExpiresAt: undefined,
  refreshTokenExpiresAt: undefined,
})
