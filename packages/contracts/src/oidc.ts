import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

/** A saved workload trust rule. Values are exact strings; array claims match by intersection. */
export const OidcPolicy = Schema.Struct({
  issuer: NonEmptyString(2048),
  claims: Schema.Record(Schema.String, Schema.Array(NonEmptyString(2048)).check(Schema.isMaxLength(32))),
  label: Schema.optionalKey(NonEmptyString(100)),
})
export type OidcPolicy = typeof OidcPolicy.Type

export type OidcPolicyError = { readonly path: string; readonly message: string }

/** Validate before a rule reaches storage. A rule without an aud or any rules never matches. */
export const validateOidcPolicy = (policy: OidcPolicy): readonly OidcPolicyError[] => {
  const errors: OidcPolicyError[] = []
  let url: URL | undefined
  try {
    url = new URL(policy.issuer)
  } catch {
    // expected: an invalid URL is a validation result, never an exception to a caller.
    errors.push({ path: 'issuer', message: 'Issuer must be a valid URL.' })
  }
  if (url !== undefined && (url.protocol !== 'https:' || url.search !== '' || url.hash !== ''))
    errors.push({ path: 'issuer', message: 'Issuer must be an https URL without query or fragment.' })
  if (!Object.hasOwn(policy.claims, 'aud')) errors.push({ path: 'claims.aud', message: 'An aud rule is required.' })
  if (Object.keys(policy.claims).length === 0)
    errors.push({ path: 'claims', message: 'At least one claim rule is required.' })
  for (const [name, values] of Object.entries(policy.claims)) {
    if (name.trim() === '' || ['__proto__', 'constructor', 'prototype'].includes(name))
      errors.push({ path: `claims.${name}`, message: 'Claim name is not allowed.' })
    if (values.length === 0 || values.some((value) => value === ''))
      errors.push({ path: `claims.${name}`, message: 'Claim values must be non-empty strings.' })
  }
  return errors
}

const WorkloadId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))

/** A workspace's trust policy, attached to an existing server grant. No credential is returned. */
export const TrustedWorkloadView = Schema.Struct({
  id: WorkloadId,
  policy: OidcPolicy,
  label: Schema.String,
  grantId: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
  disabledAt: Schema.optionalKey(Schema.String),
})
export type TrustedWorkloadView = typeof TrustedWorkloadView.Type

/** Reuse a server's identity and grant; optionally retire its static secret once trust is saved. */
export const CreateTrustedWorkload = Schema.Struct({
  policy: OidcPolicy,
  grantId: WorkloadId,
  disableKeySecret: Schema.Boolean,
})
export type CreateTrustedWorkload = typeof CreateTrustedWorkload.Type

const claimMatches = (actual: unknown, accepted: readonly string[]): boolean => {
  const values = Array.isArray(actual) ? actual : [actual]
  return values.some((value) => typeof value === 'string' && accepted.includes(value))
}

/** Match a verified JWT payload against a rule. */
export const matchesOidcPolicy = (policy: OidcPolicy, claims: Record<string, unknown>): boolean =>
  validateOidcPolicy(policy).length === 0 &&
  claims.iss === policy.issuer &&
  Object.entries(policy.claims).every(([name, accepted]) => claimMatches(claims[name], accepted))
