import * as Schema from 'effect/Schema'

/**
 * The id the deployment's OpenID Connect provider signs in under (ADR 0064): the browser names it to start a sign-in,
 * and it ends the callback the provider returns to, `/api/auth/callback/oidc`.
 */
export const OIDC_PROVIDER_ID = 'oidc'

/**
 * How someone signs in here (ADR 0064): an emailed code when the deployment can send mail, and its OpenID Connect
 * provider when one is configured, under the button's words.
 */
export const SignInMethod = Schema.Union([
  Schema.Struct({ method: Schema.Literal('email') }),
  Schema.Struct({ method: Schema.Literal('oidc'), label: Schema.String }),
])
export type SignInMethod = typeof SignInMethod.Type

/** How sign-up works: anyone (`open`), with the invite code (`invite`), or not at all (`closed`). */
export const SignupMode = Schema.Literals(['open', 'invite', 'closed'])
export type SignupMode = typeof SignupMode.Type

/**
 * What this deployment has of the parts it may go without (ADR 0064), each a binding of its own: files over 128 KiB
 * (an R2 bucket; smaller ones stay in the agent), agent apps and `code_run` (Dynamic Workers) and flow metrics
 * (Analytics Engine).
 */
export const DeploymentFeatures = Schema.Struct({
  largeFiles: Schema.Boolean,
  agentApps: Schema.Boolean,
  flows: Schema.Boolean,
})
export type DeploymentFeatures = typeof DeploymentFeatures.Type

/**
 * `GET /health`, public: that the Worker answers, its stage label, how sign-up works, the ways to sign in and the
 * optional features. Nothing about any account.
 */
export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal('goblin'),
  stage: Schema.optional(Schema.String),
  signup: SignupMode,
  signIn: Schema.Array(SignInMethod),
  features: DeploymentFeatures,
})
export type Health = typeof Health.Type
