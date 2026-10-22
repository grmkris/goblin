import type { ClientReach, InboundClient, ReachedWorkspace } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { NotFound } from '../http/errors.ts'
import { grantedScopes } from './principal.ts'
import { type Person, reachedBy, workspacesOf } from './workspaces.ts'

type Row = {
  clientId: string
  name: string | null
  uri: string | null
  consentedAt: string | number | null
  scopes: string
}

const text = (value: string | number | null): string | undefined =>
  value === null ? undefined : typeof value === 'number' ? new Date(value).toISOString() : value

const reachedOf = ({ id, slug, name }: ReachedWorkspace): ReachedWorkspace => ({ id, slug, name })

/**
 * The MCP clients this person has consented to and not revoked (ADRs 0024, 0097), newest first: the scopes their
 * consent grants and the workspaces each reaches now.
 */
export const listInboundClients = async (env: RuntimeEnv, userId: string): Promise<readonly InboundClient[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `SELECT c.clientId AS clientId, c.name AS name, c.uri AS uri, o.createdAt AS consentedAt, o.scopes AS scopes
       FROM oauthConsent o JOIN oauthClient c ON c.clientId = o.clientId
      WHERE o.userId = ? AND o.referenceId IS NULL AND (c.disabled IS NULL OR c.disabled = 0)
      ORDER BY o.createdAt DESC`,
  )
    .bind(userId)
    .all<Row>()
  return Promise.all(
    results.map(async (row) => {
      const consentedAt = text(row.consentedAt)
      const reached = await reachedBy(env.AUTH_DB, userId, row.clientId)
      return {
        clientId: row.clientId,
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.uri === null ? {} : { uri: row.uri }),
        ...(consentedAt === undefined ? {} : { consentedAt }),
        scopes: grantedScopes(row),
        reach: { all: reached?.all ?? false, workspaces: (reached?.workspaces ?? []).map(reachedOf) },
      }
    }),
  )
}

/**
 * Which of `person`'s workspaces MCP client `clientId` reaches (ADR 0097): all of theirs, ones they join later
 * included, or those listed, each one they are a member of (`NotFound` `workspace`). The consent page sets it before
 * the consent itself; Settings changes it later. One D1 batch.
 */
export const setClientReach = async (
  env: RuntimeEnv,
  person: Person,
  clientId: string,
  reach: ClientReach,
): Promise<ClientReach> => {
  const db = env.AUTH_DB
  const client = await db.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?').bind(clientId).first()
  if (client === null) throw new NotFound({ what: 'client' })
  const mine = new Set((await workspacesOf(db, person, new Date())).map((workspace) => workspace.id))
  const listed = reach.all ? [] : [...new Set(reach.workspaces)]
  if (listed.some((id) => !mine.has(id))) throw new NotFound({ what: 'workspace' })
  await db.batch([
    db
      .prepare(
        `INSERT INTO mcpReach (clientId, userId, "all", updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT (clientId, userId) DO UPDATE SET "all" = excluded."all", updatedAt = excluded.updatedAt`,
      )
      .bind(clientId, person.id, reach.all ? 1 : 0, new Date().toISOString()),
    db.prepare('DELETE FROM mcpReachWorkspace WHERE clientId = ? AND userId = ?').bind(clientId, person.id),
    // Each only while the person is still its member: a removal between the check above and this batch adds none.
    ...listed.map((workspaceId) =>
      db
        .prepare(
          `INSERT INTO mcpReachWorkspace (clientId, userId, workspaceId)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
        )
        .bind(clientId, person.id, workspaceId, workspaceId, person.id),
    ),
  ])
  return { all: reach.all, workspaces: listed }
}

/**
 * End a client's access for this person now (ADR 0097): their consent and reach go and their refresh tokens are
 * revoked. Access tokens stop working at once because every /mcp request checks the consent. Other people's use of the
 * same client is untouched.
 */
export const revokeInboundClient = async (env: RuntimeEnv, userId: string, clientId: string): Promise<void> => {
  const db = env.AUTH_DB
  await db.batch([
    db.prepare('DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?').bind(clientId, userId),
    db.prepare('DELETE FROM mcpReachWorkspace WHERE clientId = ? AND userId = ?').bind(clientId, userId),
    db.prepare('DELETE FROM mcpReach WHERE clientId = ? AND userId = ?').bind(clientId, userId),
    db
      .prepare('UPDATE oauthRefreshToken SET revoked = ? WHERE clientId = ? AND userId = ? AND revoked IS NULL')
      .bind(new Date().toISOString(), clientId, userId),
  ])
}
