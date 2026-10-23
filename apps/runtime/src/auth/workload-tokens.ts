import type { RuntimeEnv } from '../env.ts'
import { readBytes } from '../http/body.ts'
import { Forbidden, Unauthenticated } from '../http/errors.ts'
import { hex, sha256Hex } from '../runtime/digest.ts'
import { type KeyPrincipal, verifyKey } from './api-keys.ts'
import { verifyWorkload, type WorkloadVerifier, workloadPrincipal } from './oidc-workloads.ts'

const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const PREFIX = 'gbw_'

/** Direct assertions and opaque exchanged workload tokens share the same server grant path as API keys. */
export const verifyServerBearer = async (
  env: RuntimeEnv,
  token: string,
  verify?: WorkloadVerifier,
): Promise<KeyPrincipal> => {
  if (token.startsWith('gbk_')) return verifyKey(env, token)
  if (!token.startsWith(PREFIX)) return verifyWorkload(env, token, verify)
  if (!/^gbw_[a-f0-9]{64}$/u.test(token)) throw new Unauthenticated({ reason: 'invalid-token' })
  const held = await env.AUTH_DB.prepare(
    'SELECT policyId, expiresAt FROM workloadAccessToken WHERE hash = ? AND expiresAt > ?',
  )
    .bind(await sha256Hex(token), Date.now())
    .first<{ policyId: string; expiresAt: number }>()
  if (held === null) throw new Unauthenticated({ reason: 'invalid-token' })
  const principal = await workloadPrincipal(env, held.policyId)
  return {
    ...principal,
    credential: {
      ...principal.credential,
      expiresAt: Math.min(principal.credential.expiresAt ?? held.expiresAt, held.expiresAt),
    },
  }
}

const tokenReply = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
  })
const refused = (error: string, description: string) => tokenReply({ error, error_description: description }, 400)

const exchangeInput = async (request: Request, env: RuntimeEnv): Promise<URLSearchParams | Response> => {
  if (request.method !== 'POST') return tokenReply({ error: 'invalid_request' }, 405)
  if (request.headers.has('cookie') || request.headers.has('origin')) throw new Forbidden({ reason: 'key_browser' })
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
    return refused('invalid_request', 'Use an encoded form.')
  const input = new URLSearchParams(new TextDecoder().decode(await readBytes(request, 20_480)))
  if ([...input.keys()].some((key) => input.getAll(key).length !== 1))
    return refused('invalid_request', 'Duplicate parameters are refused.')
  if (input.get('grant_type') !== JWT_GRANT) return refused('unsupported_grant_type', 'Use the JWT bearer grant.')
  if ((input.get('scope') ?? 'goblin') !== 'goblin')
    return refused('invalid_scope', 'Only goblin is supported; the saved grant limits access.')
  const resource = input.get('resource')
  if (resource !== null && resource !== `${new URL(env.APP_URL).origin}/mcp`)
    return refused('invalid_target', 'The resource must be this runtime MCP endpoint.')
  return input
}

/**
 * RFC 7523 JWT-bearer grant. No client secret or refresh token; the verified assertion selects one live policy.
 * Exchanges are once per issuer+jti, persisted atomically with the token hash, and limited by both JWT and grant.
 */
export const exchangeWorkloadToken = async (
  request: Request,
  env: RuntimeEnv,
  verify?: WorkloadVerifier,
): Promise<Response> => {
  const input = await exchangeInput(request, env)
  if (input instanceof Response) return input
  const assertion = input.get('assertion')
  if (assertion === null || assertion === '') return refused('invalid_grant', 'missing-token')
  let admitted: Awaited<ReturnType<typeof verifyWorkload>>
  try {
    admitted = await verifyWorkload(env, assertion, verify)
  } catch (cause) {
    if (cause instanceof Unauthenticated) return refused('invalid_grant', cause.reason ?? 'invalid-token')
    throw cause
  }
  const { jti, iss, exp } = admitted.claims
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 200 || typeof exp !== 'number')
    return refused('invalid_grant', 'A bounded jti is required for exchange.')
  const now = Date.now()
  const end = Math.floor(Math.min(now + 300_000, exp * 1000, admitted.credential.expiresAt ?? Infinity) / 1000) * 1000
  if (end <= now) return refused('invalid_grant', 'invalid-token')
  const token = `${PREFIX}${hex(crypto.getRandomValues(new Uint8Array(32)))}`
  const digest = await sha256Hex(token)
  const assertionId = await sha256Hex(JSON.stringify([iss, jti]))
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM workloadAccessToken WHERE assertionExpiresAt <= ?').bind(now),
    env.AUTH_DB.prepare(
      'INSERT OR IGNORE INTO workloadAccessToken (hash, policyId, assertionId, expiresAt, assertionExpiresAt) VALUES (?, ?, ?, ?, ?)',
    ).bind(digest, admitted.policyId, assertionId, end, exp * 1000),
  ])
  const saved = await env.AUTH_DB.prepare('SELECT hash FROM workloadAccessToken WHERE assertionId = ?')
    .bind(assertionId)
    .first<{ hash: string }>()
  if (saved?.hash !== digest) return refused('invalid_grant', 'assertion-replayed')
  return tokenReply({
    access_token: token,
    token_type: 'Bearer',
    expires_in: Math.floor((end - now) / 1000),
    scope: 'goblin',
  })
}
