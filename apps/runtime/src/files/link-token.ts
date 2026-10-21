// A file link's token (ADR 0070): an HMAC, under a key derived from `CREDENTIAL_KEY` for this purpose only, over the
// user, the file's path and when the link expires (fifteen minutes at most). The Worker checks it before any agent
// wakes; plain WebCrypto, so the Worker reads it without the agent's runtime.
import { FilePath } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { base64url, bytesOfBase64url, purposeMac, purposeMacMatches } from '../runtime/purpose-key.ts'

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
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

/** A token's two parts: its claims as base64url JSON, and their HMAC. */
const FILE_LINK_TOKEN = /^([\w-]{1,4096})\.([\w-]{43})$/u

/** The token of a link to `claims.path` of workspace `claims.workspaceId`'s agent, valid until `claims.expiresAt`. */
export async function fileLinkToken(credentialKey: string, claims: LinkClaims): Promise<string> {
  const body = base64url(
    new TextEncoder().encode(JSON.stringify({ u: claims.workspaceId, p: claims.path, e: claims.expiresAt })),
  )
  return `${body}.${await purposeMac(credentialKey, PURPOSE, body)}`
}

/**
 * What `token` says, when it is one goblin made (its HMAC compared in constant time) and has not expired at `now`
 * (epoch seconds): none for anything else, a link that would outlive fifteen minutes from now included.
 */
export async function fileLinkClaims(
  credentialKey: string,
  token: string,
  now: number,
): Promise<LinkClaims | undefined> {
  const [, body = '', mac = ''] = FILE_LINK_TOKEN.exec(token) ?? []
  if (body === '' || !(await purposeMacMatches(credentialKey, PURPOSE, body, mac))) return undefined
  // Only a body goblin signed is read, so it is base64url JSON.
  const claims = Option.getOrUndefined(decodeClaims(new TextDecoder().decode(bytesOfBase64url(body))))
  if (claims === undefined || claims.e <= now || claims.e > now + FILE_LINK_SECONDS) return undefined
  return { workspaceId: claims.u, path: claims.p, expiresAt: claims.e }
}

/**
 * Where a link fetches from: `/files/link/<token>/<name>` on the deployment's own origin. The name is there for a
 * server that names what it fetched by its URL; the route ignores it.
 */
export const fileLinkUrl = (appUrl: string, token: string, name: string): string =>
  `${new URL(appUrl).origin}/files/link/${token}/${encodeURIComponent(name)}`
