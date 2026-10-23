import { type CreateTrustedWorkload, OidcPolicy, type TrustedWorkloadView, validateOidcPolicy } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../env.ts'
import { Forbidden, InvalidInput, Unauthenticated } from '../http/errors.ts'
import { isPublicHttps } from '../mcp/servers/endpoint.ts'
import { credentialOf, type KeyPrincipal } from './api-keys.ts'
import { coverageIn, grantById, isLive, mayApprove } from './grants.ts'
import { createAuth } from './options.ts'
import { type OidcResult, verifyOidcToken, workloadIssuer } from './workload-verifier.ts'

interface PolicyRow {
  readonly id: string
  readonly workspaceId: string
  readonly policy: string
  readonly label: string
  readonly grantId: string
  readonly createdBy: string
  readonly createdAt: string
  readonly disabledAt: string | null
}
const COLUMNS = 'id, workspaceId, policy, label, grantId, createdBy, createdAt, disabledAt'
const decodePolicy = Schema.decodeUnknownOption(Schema.fromJsonString(OidcPolicy))
const policyOf = (row: PolicyRow): OidcPolicy | undefined => Option.getOrUndefined(decodePolicy(row.policy))
const viewOf = (row: PolicyRow): TrustedWorkloadView => {
  const policy = policyOf(row)
  if (policy === undefined) throw new InvalidInput({ reason: 'invalid-policy' })
  return {
    id: row.id,
    policy,
    label: row.label,
    grantId: row.grantId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    ...(row.disabledAt === null ? {} : { disabledAt: row.disabledAt }),
  }
}

/** Saved trust is read live, under the member's workspace; no discovery occurs on save. */
export const listOidcPolicies = async (
  env: RuntimeEnv,
  workspaceId: string,
): Promise<readonly TrustedWorkloadView[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `SELECT ${COLUMNS} FROM trustedWorkloadPolicy WHERE workspaceId = ? ORDER BY createdAt DESC`,
  )
    .bind(workspaceId)
    .all<PolicyRow>()
  return results.map(viewOf)
}

/**
 * Map trust to an existing server grant, preserving its stable identity and everything it made. Only that
 * workspace's manager may do so. A requested retirement disables the key through Better Auth's own API, leaving
 * the grant in place. If retirement fails, the saved policy is removed and the failure is reported.
 */
export const createOidcPolicy = async (
  env: RuntimeEnv,
  workspaceId: string,
  userId: string,
  input: CreateTrustedWorkload,
): Promise<TrustedWorkloadView> => {
  if (validateOidcPolicy(input.policy).length !== 0 || !isPublicHttps(new URL(input.policy.issuer)))
    throw new InvalidInput({ reason: 'invalid-policy' })
  const audience = new URL(env.APP_URL).origin
  if (input.policy.claims['aud']?.length !== 1 || input.policy.claims['aud'][0] !== audience)
    throw new InvalidInput({ reason: 'workload_audience' })
  if (Object.keys(input.policy.claims).length > 32) throw new InvalidInput({ reason: 'invalid-policy' })
  const grant = await grantById(env.AUTH_DB, input.grantId)
  const ws = grant === undefined ? undefined : await coverageIn(env.AUTH_DB, grant, workspaceId)
  if (
    grant === undefined ||
    grant.kind !== 'key' ||
    ws === undefined ||
    !(await mayApprove(env.AUTH_DB, userId, grant))
  )
    throw new Forbidden({ reason: 'workload_grant' })
  const key = await env.AUTH_DB.prepare('SELECT id FROM apikey WHERE id = ? AND referenceId = ?')
    .bind(grant.keyId ?? '', workspaceId)
    .first<{ id: string }>()
  if (key === null || !isLive(grant, Date.now())) throw new InvalidInput({ reason: 'workload_grant' })
  const id = `wl_${crypto.randomUUID().replaceAll('-', '')}`
  const row: PolicyRow = {
    id,
    workspaceId,
    policy: JSON.stringify(input.policy),
    label: input.policy.label ?? grant.name,
    grantId: grant.id,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    disabledAt: null,
  }
  await env.AUTH_DB.prepare(`INSERT INTO trustedWorkloadPolicy (${COLUMNS}, issuer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      row.id,
      row.workspaceId,
      row.policy,
      row.label,
      row.grantId,
      row.createdBy,
      row.createdAt,
      null,
      input.policy.issuer,
    )
    .run()
  try {
    if (input.disableKeySecret)
      await createAuth(env, env.AUTH_DB).api.updateApiKey({ body: { keyId: key.id, userId, enabled: false } })
  } catch (cause) {
    // expected: retirement failed; trust is removed so a failed creation leaves no additional authority.
    await env.AUTH_DB.prepare('DELETE FROM trustedWorkloadPolicy WHERE id = ?').bind(id).run()
    throw cause
  }
  return viewOf(row)
}

/** Disable affects assertions and exchanged tokens immediately on their next request, never the shared grant. */
export const disableOidcPolicy = async (env: RuntimeEnv, workspaceId: string, id: string): Promise<void> => {
  await env.AUTH_DB.prepare(
    'UPDATE trustedWorkloadPolicy SET disabledAt = coalesce(disabledAt, ?) WHERE id = ? AND workspaceId = ?',
  )
    .bind(new Date().toISOString(), id, workspaceId)
    .run()
}

/** A policy's live server principal. The disabled static key is only the grant's identity anchor. */
export const workloadPrincipal = async (env: RuntimeEnv, policyId: string): Promise<KeyPrincipal> => {
  const policy = await env.AUTH_DB.prepare(
    'SELECT workspaceId, grantId FROM trustedWorkloadPolicy WHERE id = ? AND disabledAt IS NULL',
  )
    .bind(policyId)
    .first<{ workspaceId: string; grantId: string }>()
  if (policy === null) throw new Unauthenticated({ reason: 'policy-disabled' })
  const grant = await grantById(env.AUTH_DB, policy.grantId)
  if (grant === undefined || grant.kind !== 'key' || grant.keyId === undefined || !isLive(grant, Date.now()))
    throw new Unauthenticated({ reason: 'grant_expired' })
  const ws = await coverageIn(env.AUTH_DB, grant, policy.workspaceId)
  const key = await env.AUTH_DB.prepare('SELECT id FROM apikey WHERE id = ? AND referenceId = ?')
    .bind(grant.keyId, policy.workspaceId)
    .first<{ id: string }>()
  if (ws === undefined || key === null) throw new Unauthenticated({ reason: 'policy-disabled' })
  return {
    workspaceId: policy.workspaceId,
    credential: { ...credentialOf(grant, { id: key.id, name: grant.name }, ws), workload: true },
  }
}

export type WorkloadVerifier = (token: string, policies: readonly OidcPolicy[]) => Promise<OidcResult>

/** Issuer is only a bounded SQL lookup hint. Exactly one fully verified live policy chooses the workspace. */
export const verifyWorkload = async (env: RuntimeEnv, token: string, verify: WorkloadVerifier = verifyOidcToken) => {
  const issuer = workloadIssuer(token)
  if (issuer === undefined) throw new Unauthenticated({ reason: 'malformed-token' })
  const { results } = await env.AUTH_DB.prepare(
    `SELECT ${COLUMNS} FROM trustedWorkloadPolicy WHERE issuer = ? AND disabledAt IS NULL LIMIT 101`,
  )
    .bind(issuer)
    .all<PolicyRow>()
  if (results.length > 100) throw new Unauthenticated({ reason: 'invalid-policy' })
  const candidates = results.flatMap((row) => {
    const policy = policyOf(row)
    return policy === undefined ? [] : [{ row, policy }]
  })
  const verified = await verify(
    token,
    candidates.map(({ policy }) => policy),
  )
  if (!verified.ok) throw new Unauthenticated({ reason: verified.code })
  const found = candidates.find(({ policy }) => policy === verified.policy)
  if (found === undefined) throw new Unauthenticated({ reason: 'claims-mismatch' })
  const principal = await workloadPrincipal(env, found.row.id)
  // The signature's expiry bounds admission as well as the grant's own lifetime.
  const tokenEnd = (verified.claims.exp ?? 0) * 1000
  const credential = {
    ...principal.credential,
    expiresAt: Math.min(principal.credential.expiresAt ?? tokenEnd, tokenEnd),
  }
  return { ...principal, credential, policyId: found.row.id, claims: verified.claims }
}
