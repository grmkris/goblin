import { GRANT_SPEC, type Need, ROLE_POWER, type WorkspaceView, missingFor } from '@goblin/contracts'
import { type AppError, Forbidden, accessInsufficient } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import type { Credential, Member } from './principal.ts'

/**
 * How the edge admits a credential (ADRs 0114, 0116, 0118, 0120): an OAuth token, a client's or an installed app's, on
 * a workspace's path, held to what the endpoint it names needs.
 */

/** An OAuth token admitted on a workspace's path: its workspace, credential, and the person it acts for if any. */
export interface TokenAdmission {
  readonly workspace: WorkspaceView
  readonly credential: Credential
  readonly member?: Member
}

/** What admitting a credential asks of the deployment: its own origin, and the token check. */
export interface CredentialEdge {
  /** The app's own origin: every browser write comes from it, and a refusal's widening link is under it. */
  readonly origin: string
  /**
   * An OAuth token on a workspace's path (ADR 0116): the workspace at the slug among those it reaches now, the credential
   * its grant makes there, and for a client acting for a person that person as a member of it (an installed app's, ADR
   * 0118, acts for no one); `Unauthenticated` for a token that does not admit, `NotFound` `workspace` for a slug it does
   * not reach.
   */
  readonly client: (token: string, slug: string) => Effect.Effect<TokenAdmission, AppError>
}

/**
 * Whether a credential's grant holds what the endpoint a request names needs (ADR 0114): `need`, none for an endpoint no
 * credential reaches (`Forbidden` `credential`), else `AccessInsufficient` with what it lacks and the link to widen it.
 */
const holds = (edge: CredentialEdge, credential: Credential, need: Need | undefined): Effect.Effect<void, AppError> => {
  if (need === undefined) return Effect.fail(new Forbidden({ reason: 'credential' }))
  const missing = missingFor(GRANT_SPEC, credential, need)
  return missing === null ? Effect.void : accessInsufficient(edge.origin, credential.grantId, missing)
}

/**
 * Admission of an OAuth token on a workspace's path (ADRs 0116, 0118): one request has one principal, so a session
 * cookie with it is refused; the token must admit and reach the workspace at `slug` (for a client, for its person; for
 * an app, by its installation), a client's person's role must be able to hold what the endpoint needs (`role`), and its
 * grant must hold it (`holds`). The workspace, the
 * credential its grant makes there and, for a client, its person as a member of it, whose role the agent holds the
 * request to as it does a `/mcp` call's.
 */
export const admitClient = (
  request: Request,
  edge: CredentialEdge,
  token: string,
  slug: string,
  need: Need | undefined,
): Effect.Effect<TokenAdmission, AppError> =>
  Effect.gen(function* () {
    if (request.headers.has('cookie')) return yield* new Forbidden({ reason: 'bearer_and_session' })
    const admitted = yield* edge.client(token, slug)
    // What a client's person's role could never hold (ROLE_POWER) is refused for it, not offered as a widening; an
    // app has no person, and its installation's grant was capped by its installer's role.
    const role = admitted.member?.role
    if (need !== undefined && role !== undefined && missingFor(GRANT_SPEC, ROLE_POWER[role], need) !== null)
      return yield* new Forbidden({ reason: 'role' })
    yield* holds(edge, admitted.credential, need)
    return admitted
  })
