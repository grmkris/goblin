import type { InboundClient, ReachedWorkspace } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { grantOfClient, revokeClientGrant, termsOf } from './grants.ts'
import { reachedBy } from './workspaces.ts'

type Row = {
  clientId: string
  name: string | null
  uri: string | null
  consentedAt: string | number | null
}

const text = (value: string | number | null): string | undefined =>
  value === null ? undefined : typeof value === 'number' ? new Date(value).toISOString() : value

const reachedOf = ({ id, slug, name }: ReachedWorkspace): ReachedWorkspace => ({ id, slug, name })

/**
 * The MCP clients this person has consented to and not revoked (ADRs 0024, 0097, 0114), newest first: the grant they
 * gave each, with its terms, and the workspaces each reaches now.
 */
export const listInboundClients = async (env: RuntimeEnv, userId: string): Promise<readonly InboundClient[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `SELECT c.clientId AS clientId, c.name AS name, c.uri AS uri, o.createdAt AS consentedAt
       FROM oauthConsent o JOIN oauthClient c ON c.clientId = o.clientId
      WHERE o.userId = ? AND o.referenceId IS NULL AND (c.disabled IS NULL OR c.disabled = 0)
      ORDER BY o.createdAt DESC`,
  )
    .bind(userId)
    .all<Row>()
  return Promise.all(
    results.map(async (row) => {
      const consentedAt = text(row.consentedAt)
      const [reached, grant] = await Promise.all([
        reachedBy(env.AUTH_DB, userId, row.clientId),
        grantOfClient(env.AUTH_DB, row.clientId, userId),
      ])
      const live = grant === undefined || grant.revokedAt !== null ? undefined : grant
      return {
        clientId: row.clientId,
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.uri === null ? {} : { uri: row.uri }),
        ...(consentedAt === undefined ? {} : { consentedAt }),
        reach: { all: reached?.all ?? false, workspaces: (reached?.workspaces ?? []).map(reachedOf) },
        ...(live === undefined ? {} : { grantId: live.id, terms: await termsOf(env.AUTH_DB, live) }),
      }
    }),
  )
}

/**
 * End a client's access for this person now (ADRs 0097, 0114): their grant is marked revoked, their consent goes and
 * their refresh tokens are revoked. Access tokens stop working at once because every /mcp request checks the consent and
 * the grant. Other people's use of the same client is untouched.
 */
export const revokeInboundClient = async (env: RuntimeEnv, userId: string, clientId: string): Promise<void> => {
  await revokeClientGrant(env.AUTH_DB, userId, clientId, Date.now())
}
