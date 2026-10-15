import type { DeploymentFeatures, Health, SignInMethod } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { mailerOf } from '../auth/mail.ts'
import { oidcProviderOf } from '../auth/oidc.ts'
import { signupMode } from '../auth/signup.ts'

/** The ways to sign in here (ADR 0064): an emailed code when mail can be sent, the deployment's provider when set. */
export const signInMethods = (env: RuntimeEnv): readonly SignInMethod[] => {
  const provider = oidcProviderOf(env)
  return [
    ...(mailerOf(env) === undefined ? [] : [{ method: 'email' as const }]),
    ...(provider === undefined ? [] : [{ method: 'oidc' as const, label: provider.label }]),
  ]
}

/** The optional bindings the deployment has (ADR 0064). */
export const featuresOf = (env: RuntimeEnv): DeploymentFeatures => ({
  largeFiles: env.FILES !== undefined,
  agentApps: env.LOADER !== undefined,
  flows: env.FLOWS !== undefined,
  decisions: env.AI !== undefined,
})

/** `GET /health`: what the deployment is and offers, from its settings alone (no request reaches a binding). */
export const healthOf = (env: RuntimeEnv): Health => ({
  ok: true,
  service: 'goblin',
  ...(env.STAGE === undefined ? {} : { stage: env.STAGE }),
  signup: signupMode(env.SIGNUP_MODE),
  signIn: signInMethods(env),
  features: featuresOf(env),
})
