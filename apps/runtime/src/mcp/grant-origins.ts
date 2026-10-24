import type { GrantOrigin } from '@goblin/contracts'
import { coverageIn, grantById, isLive } from '../auth/grants.ts'
import type { RuntimeEnv } from '../env.ts'

/**
 * The MCP origins grant `grantId` gives its threads in workspace `workspaceId` now (ADRs 0091, 0114), read from the
 * auth store; none once the grant is gone, revoked or past its end, or no longer reaches the workspace (and, for a
 * client's, once its person is no member there). A thread's declared servers are checked against it at every use
 * (ADR 0103).
 */
export async function grantOriginsNow(
  env: RuntimeEnv,
  workspaceId: string,
  grantId: string,
): Promise<readonly GrantOrigin[] | undefined> {
  const grant = await grantById(env.AUTH_DB, grantId)
  if (grant === undefined || !isLive(grant, Date.now())) return undefined
  if ((await coverageIn(env.AUTH_DB, grant, workspaceId)) === undefined) return undefined
  if (grant.kind === 'client') {
    const member = await env.AUTH_DB.prepare('SELECT 1 AS present FROM member WHERE organizationId = ? AND userId = ?')
      .bind(workspaceId, grant.userId ?? '')
      .first()
    if (member === null) return undefined
  }
  return grant.origins
}
