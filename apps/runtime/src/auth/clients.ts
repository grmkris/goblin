import type { InboundClient } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'

type Row = { clientId: string; name: string | null; uri: string | null; consentedAt: string | number | null }

const text = (value: string | number | null): string | undefined =>
  value === null ? undefined : typeof value === 'number' ? new Date(value).toISOString() : value

/** MCP clients this person has consented to for this workspace (ADR 0089) and not revoked. */
export const listInboundClients = async (
  env: RuntimeEnv,
  userId: string,
  workspaceId: string,
): Promise<readonly InboundClient[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `SELECT c.clientId AS clientId, c.name AS name, c.uri AS uri, MIN(o.createdAt) AS consentedAt
       FROM oauthConsent o JOIN oauthClient c ON c.clientId = o.clientId
      WHERE o.userId = ? AND o.referenceId = ? AND (c.disabled IS NULL OR c.disabled = 0)
      GROUP BY c.clientId, c.name, c.uri ORDER BY consentedAt DESC`,
  )
    .bind(userId, workspaceId)
    .all<Row>()
  return results.map((row) => {
    const consentedAt = text(row.consentedAt)
    return {
      clientId: row.clientId,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.uri === null ? {} : { uri: row.uri }),
      ...(consentedAt === undefined ? {} : { consentedAt }),
    }
  })
}

/**
 * End a client's access to this workspace's agent for this person now: their consent for it goes and their refresh
 * tokens for it are revoked. Access tokens stop working at once because every /mcp request checks the consent. Their
 * consents to other workspaces, and other people's, are untouched.
 */
export const revokeInboundClient = async (
  env: RuntimeEnv,
  userId: string,
  workspaceId: string,
  clientId: string,
): Promise<void> => {
  const revokedAt = new Date(nowSeconds() * 1000).toISOString()
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM oauthConsent WHERE clientId = ? AND userId = ? AND referenceId = ?').bind(
      clientId,
      userId,
      workspaceId,
    ),
    env.AUTH_DB.prepare(
      'UPDATE oauthRefreshToken SET revoked = ? WHERE clientId = ? AND userId = ? AND referenceId = ? AND revoked IS NULL',
    ).bind(revokedAt, clientId, userId, workspaceId),
  ])
}
