import { Predicate } from 'effect'
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { mcp } from '@better-auth/mcp'
import { type Account, betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { Conflict } from '../http/errors.ts'
import { emailOTP, jwt, organization } from 'better-auth/plugins'
import type { RuntimeEnv } from '../env.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { CODE_SEND, CODE_SIGN_IN, guardEmailCode } from './email-code.ts'
import { codeMail, mailerOf } from './mail.ts'
import { guardOidc, oidcPlugin, oidcProviderOf, refuseUnverifiedOidcUser, withoutProviderTokens } from './oidc.ts'
import { clientSecretHash } from './client-secret.ts'
import { guardAuthorization, guardRegistration } from './protocol.ts'
import { KEY_LENGTH, KEY_PREFIX, KEY_START_LENGTH, MCP_SCOPES, mcpResource } from './resources.ts'
import { workspaceAccess } from './roles.ts'
import { deleteAgentOf } from './account.ts'
import { deleteOwnedAlone } from './workspaces.ts'

export const AUTH_BASE_PATH = '/api/auth'
export const authIssuer = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}${AUTH_BASE_PATH}`

/** Fifteen minutes: an access token is short-lived (the spec's SHOULD); a client refreshes, and a revoke ends it anyway. */
const ACCESS_TOKEN_SECONDS = 900

export type AuthEnvironment = Pick<
  RuntimeEnv,
  | 'APP_URL'
  | 'BETTER_AUTH_SECRET'
  | 'SIGNUP_MODE'
  | 'SIGNUP_INVITE_CODE'
  | 'MAIL'
  | 'MAIL_SENDER'
  | 'AGENTS'
  | 'STAGE'
  | 'OIDC_ISSUER'
  | 'OIDC_CLIENT_ID'
  | 'OIDC_CLIENT_SECRET'
  | 'OIDC_LABEL'
  | 'CLIENT_METADATA_FETCH'
>

/** Per-IP limits on the endpoints that create accounts or send mail; everything else keeps the default window. */
const RATE_LIMITS = {
  '/delete-user': { window: 300, max: 5 },
  [CODE_SEND]: { window: 3600, max: 10 },
  [CODE_SIGN_IN]: { window: 300, max: 20 },
  '/sign-in/social': { window: 300, max: 20 },
} as const

/** Six-digit sign-in codes: ten minutes, five attempts, stored hashed. Mail is required to send a code. */
type MailDelivery = { failed: boolean }
const codePlugin = (env: AuthEnvironment, delivery: MailDelivery) =>
  emailOTP({
    otpLength: 6,
    expiresIn: 600,
    allowedAttempts: 5,
    storeOTP: 'hashed',
    sendVerificationOTP: async ({ email, otp }) => {
      try {
        const mailer = mailerOf(env)
        if (mailer === undefined) {
          delivery.failed = true
          return
        }
        await mailer.binding.send(
          codeMail({
            from: mailer.from,
            to: email,
            code: otp,
            appUrl: env.APP_URL,
            ...(env.STAGE === undefined ? {} : { stage: env.STAGE }),
          }),
        )
      } catch (cause) {
        // The after hook answers the owner with a 503; the operator sees the mailer's failure here.
        writeLine('error', { event: 'failure', where: 'auth.sendCode', 'error.type': safeErrorType(cause) })
        delivery.failed = true
      }
    },
  })

/**
 * Server API keys (ADR 0081): hashed at rest, named and `gbk_`-prefixed. A key's lifetime is its grant's (ADR 0114),
 * so the plugin keeps no expiry of its own: with no default it leaves a key's `expiresAt` empty (any default would be
 * written for every key made without one). A key is never turned into a session. Keys are made, listed, rotated and ended only through
 * `auth/api-keys.ts`; the plugin's own routes are not served (`handleAuth`). The plugin's per-key limiter is off, for
 * keys made before too (its global switch is read first): it resets only after a quiet window, so a steady client
 * piled up to the limit and was cut off. A key's agent counts its requests per fixed minute instead (ADR 0085).
 */
const keyPlugin = () =>
  apiKey({
    // A key belongs to a workspace (ADR 0089): its `referenceId` is the workspace's ID, and who made it is in its
    // metadata.
    references: 'organization',
    defaultPrefix: KEY_PREFIX,
    defaultKeyLength: KEY_LENGTH,
    requireName: true,
    maximumNameLength: 64,
    enableMetadata: true,
    enableSessionForAPIKeys: false,
    startingCharactersConfig: { shouldStore: true, charactersLength: KEY_START_LENGTH },
    keyExpiration: { defaultExpiresIn: null, minExpiresIn: 1, maxExpiresIn: 365 },
    rateLimit: { enabled: false },
  })

/**
 * Workspaces (ADR 0089): each is an organization that owns one agent, named by its ID; a person belongs to it with a
 * role. The plugin keeps the records and checks a role's permissions; none of its own routes is served (`handleAuth`),
 * and the Worker's account API reads and writes its tables itself (`auth/workspaces.ts`), in one D1 batch where a
 * change spans rows.
 */
const workspacePlugin = () =>
  organization({
    ...workspaceAccess,
    creatorRole: 'owner',
    disableOrganizationDeletion: true,
  })

/**
 * Email codes and the deployment's OpenID Connect provider are the only identity proofs. Unsupported account methods
 * cannot create credentials or send mail, and a provider's account is for signing in only: it is never linked by hand,
 * nor are its tokens handed out.
 */
const unavailableMethod = (path: string): boolean =>
  path.startsWith('/sign-up') ||
  path.startsWith('/passkey/') ||
  [
    '/sign-in/email',
    '/request-password-reset',
    '/reset-password',
    '/change-password',
    '/set-password',
    '/send-verification-email',
    '/verify-email',
    '/change-email',
    '/link-social',
    '/unlink-account',
    '/get-access-token',
    '/refresh-token',
    '/account-info',
  ].some((route) => path === route || path.startsWith(`${route}/`))

/** A field of a request body, which Better Auth hands its hooks untyped. */
const bodyField = (body: unknown, name: string): unknown => (Predicate.hasProperty(body, name) ? body[name] : undefined)

/** Every gate Better Auth's own options cannot express, before any endpoint runs. */
const beforeAuth = (env: AuthEnvironment, database: D1Database) =>
  createAuthMiddleware(async (context) => {
    // The MCP authorization spec's rules for a registration and an authorization (ADR 0122, `protocol.ts`).
    if (context.path === '/oauth2/register') {
      guardRegistration(context.body)
      return
    }
    if (context.path === '/oauth2/authorize') {
      guardAuthorization(context.query)
      return
    }
    if (unavailableMethod(context.path ?? '')) throw new APIError('NOT_FOUND', { message: 'Not found' })
    // Deletion requires a fresh OTP session; no token or password bypass is available.
    if (context.path?.startsWith('/delete-user')) {
      const body: unknown = context.body
      if (
        context.path !== '/delete-user' ||
        bodyField(body, 'token') !== undefined ||
        bodyField(body, 'password') !== undefined
      )
        throw new APIError('BAD_REQUEST', { message: 'Invalid request' })
      return
    }
    if (guardOidc(context, env)) return
    await guardEmailCode(context, env, database, Date.now())
  })

/** What an instance needs beyond the deployment's settings. */
export type AuthNeeds = {
  /**
   * The OpenID Connect provider's own routes (`oidc.ts` `isOidcPath`): only then is the provider built, since building
   * it reads the issuer's discovery document, and Better Auth is built again for every request.
   */
  readonly provider?: boolean
}

/**
 * Before an account goes: the workspaces it alone owns, each agent erased first (`deleteOwnedAlone`). The last owner of
 * a workspace other people work in is refused (409), so nobody's workspace goes with someone else's account.
 */
const beforeAccountDelete = (env: AuthEnvironment, database: D1Database) => async (user: { id: string }) => {
  try {
    await deleteOwnedAlone({ db: database, eraseAgent: (workspaceId) => deleteAgentOf(env, workspaceId) }, user.id)
  } catch (cause) {
    if (cause instanceof Conflict) throw new APIError('CONFLICT', { message: 'last_owner', code: 'LAST_OWNER' })
    throw cause
  }
}

/**
 * Better Auth is instantiated per request: Worker I/O promises cannot outlive their request. The D1 adapter owns
 * auth tables; application Drizzle never adopts/migrates them. mcp() already includes OAuth provider functionality.
 */
const authOptions = (env: AuthEnvironment, database: D1Database, needs: AuthNeeds) => {
  // Better Auth 1.7.6 swallows mail callback errors. Its after hook must refuse success and erase an undelivered
  // code. This state belongs to one auth instance/request, never the Worker isolate or another user's request.
  const delivery: MailDelivery = { failed: false }
  const resource = mcpResource(env.APP_URL)
  const provider = needs.provider === true ? oidcProviderOf(env) : undefined
  const oauthPlugin = mcp({
    resource,
    // One resource, and a token for it carries only these scopes (ADR 0024). Config is the source of truth for the row:
    // `merge` applies a changed scope list to the row an earlier deploy created.
    resources: [{ identifier: resource, name: 'goblin', allowedScopes: [...MCP_SCOPES] }],
    resourceSeedMode: 'merge',
    scopes: [...MCP_SCOPES],
    loginPage: '/login',
    consentPage: '/consent',
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    // MCP clients register themselves before the owner signs in: by a Client ID Metadata Document (`cimd()` below, the
    // spec's preferred way) or dynamically, until the clients that matter are seen connecting by document (ADR 0122).
    // Registration grants nothing: every client needs its person's consent and a grant they approve (ADR 0114). Only
    // the /mcp resource can be requested. A dynamic registration that says no `application_type` is native when a
    // redirect is http on loopback, as Claude Code's and VS Code's are (RFC 8252), else web.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultApplicationType: 'infer',
    clientRegistrationAllowedResources: [resource],
    clientRegistrationDefaultScopes: [...MCP_SCOPES],
    // A consent names no workspace (ADR 0097): which of the person's workspaces a client reaches is its grant's reach,
    // which the consent page sets first and every /mcp call reads, so the standard consent and its re-authorization
    // apply.
    // An app's secret is kept as Better Auth's default hash, named here so goblin's rotation writes the same
    // (`client-secret.ts`, ADR 0118).
    storeClientSecret: { hash: clientSecretHash },
    // Only goblin registers clients with the client_credentials grant: server-side, after its own check that the
    // person manages the workspace (`installs.ts`). Better Auth's own client endpoints are not served (`handleAuth`), so
    // this hook only ever answers goblin's calls.
    clientPrivileges: () => true,
  })
  return {
    appName: 'goblin',
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [env.APP_URL],
    logger: { disabled: true },
    emailAndPassword: { enabled: false },
    // Deleting an account first deletes every workspace it alone owns, each agent erased before its records (ADR
    // 0089); D1 then cascades the person's other memberships, sessions, consents and tokens. It requires a sign-in from
    // the last 10 minutes.
    session: { freshAge: 600 },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: beforeAccountDelete(env, database),
      },
      validateUserInfo: refuseUnverifiedOidcUser,
    },
    // A provider's account joins an existing one only when the provider says the email is verified and the account's
    // own is (by an emailed code); no provider is trusted past that. Its tokens are never kept or refreshed.
    account: {
      updateAccountOnSignIn: false,
      accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: true },
    },
    databaseHooks: {
      account: { create: { before: async (account: Account) => ({ data: withoutProviderTokens(account) }) } },
    },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 100, customRules: RATE_LIMITS },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: {
      before: beforeAuth(env, database),
      after: createAuthMiddleware(async (context) => {
        if (context.path !== CODE_SEND || !delivery.failed) return
        const email = bodyField(context.body, 'email')
        const identifier = `sign-in-otp-${Predicate.isString(email) ? email : ''}`
        await context.context.internalAdapter.deleteVerificationByIdentifier(identifier)
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'Could not send a sign-in code. Try again.' })
      }),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: authIssuer(env.APP_URL), audience: resource } }),
      // SAFETY: Better Auth 1.7.6 MCP endpoint metadata types violate exactOptionalPropertyTypes; runtime shape is the pinned official plugin.
      oauthPlugin as BetterAuthPlugin,
      // Client ID Metadata Documents (ADR 0122): a client is the https URL of its own metadata, fetched once an hour at
      // most, validated against the MCP profile and kept as an `oauthClient` row like any other. The fetch is the
      // Worker's own `fetch`, which `global_fetch_strictly_public` keeps off private and special-use addresses
      // (`apps/web/alchemy.run.ts`); the plugin refuses redirects and non-https ids itself. A fixture hands its own.
      cimd({
        fetchClientMetadataResource: env.CLIENT_METADATA_FETCH ?? ((input, init) => fetch(input, init)),
        metadataProfile: 'mcp-2026-07-28',
      }),
      codePlugin(env, delivery),
      workspacePlugin(),
      keyPlugin(),
      ...(provider === undefined ? [] : [oidcPlugin(provider)]),
    ],
  }
}
export const createAuth = (env: AuthEnvironment, database: D1Database, needs: AuthNeeds = {}) =>
  betterAuth(authOptions(env, database, needs))
