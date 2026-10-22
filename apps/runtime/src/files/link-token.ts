// A file link's token (ADR 0070): signed for this purpose only (`runtime/signed-token.ts`) over the workspace, the
// file's path and when the link expires (fifteen minutes at most).
import { FilePath } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { signedClaims, signedToken } from '../runtime/signed-token.ts'

/** How long a file link is valid, in seconds. */
export const FILE_LINK_SECONDS = 900

/** The purpose a file link's token is made for. */
const PURPOSE = 'goblin/files/link'

/** What a link's token says: whose file, which one, and until when (epoch seconds). */
type LinkClaims = { readonly workspaceId: string; readonly path: string; readonly expiresAt: number }

/** The claims as the token carries them, in short keys. */
const Claims = Schema.Struct({
  u: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  p: FilePath,
  e: Schema.Int,
})

/** The token of a link to `claims.path` of workspace `claims.workspaceId`'s agent, valid until `claims.expiresAt`. */
export const fileLinkToken = (credentialKey: string, claims: LinkClaims): Promise<string> =>
  signedToken(credentialKey, PURPOSE, { u: claims.workspaceId, p: claims.path, e: claims.expiresAt })

/**
 * What `token` says, when it is one goblin made and has not expired at `now` (epoch seconds): none for anything else,
 * a link that would outlive fifteen minutes from now included.
 */
export async function fileLinkClaims(
  credentialKey: string,
  token: string,
  now: number,
): Promise<LinkClaims | undefined> {
  const claims = await signedClaims(credentialKey, PURPOSE, token, Claims)
  if (claims === undefined || claims.e <= now || claims.e > now + FILE_LINK_SECONDS) return undefined
  return { workspaceId: claims.u, path: claims.p, expiresAt: claims.e }
}
/**
 * Where a link fetches from: `/files/link/<token>/<name>` on the deployment's own origin. The name is there for a
 * server that names what it fetched by its URL; the route ignores it.
 */
export const fileLinkUrl = (appUrl: string, token: string, name: string): string =>
  `${new URL(appUrl).origin}/files/link/${token}/${encodeURIComponent(name)}`
