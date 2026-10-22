// A stream URL's token (docs/architecture/streams.md): signed for this purpose only (`runtime/signed-token.ts`) over
// the workspace, the chat, the tier and the epoch it reads, and when it expires (ten minutes at most). The Worker
// checks it and reaches the stream object, never the agent.
import { ChatId, StreamTier } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { signedClaims, signedToken } from '../runtime/signed-token.ts'

/** How long a stream URL is valid, in seconds. */
export const STREAM_READ_SECONDS = 600

/** The purpose a stream URL's token is made for. */
const PURPOSE = 'goblin/streams/read'

/** What a stream URL's token says: whose chat, which one, in which tier and epoch, and until when (epoch seconds). */
export type StreamReadClaims = {
  readonly workspaceId: string
  readonly chat: string
  readonly tier: StreamTier
  readonly epoch: number
  readonly expiresAt: number
}

/** The claims as the token carries them, in short keys. */
const Claims = Schema.Struct({
  w: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  c: ChatId,
  t: StreamTier,
  n: Schema.Int.check(Schema.isGreaterThan(0)),
  e: Schema.Int,
})

/** The token of a URL that reads `claims`'s stream until `claims.expiresAt`. */
export const streamReadToken = (credentialKey: string, claims: StreamReadClaims): Promise<string> =>
  signedToken(credentialKey, PURPOSE, {
    w: claims.workspaceId,
    c: claims.chat,
    t: claims.tier,
    n: claims.epoch,
    e: claims.expiresAt,
  })

/**
 * What `token` says, when it is one goblin made and has not expired at `now` (epoch seconds): none for anything else,
 * a URL that would outlive ten minutes from now included.
 */
export async function streamReadClaims(
  credentialKey: string,
  token: string,
  now: number,
): Promise<StreamReadClaims | undefined> {
  const claims = await signedClaims(credentialKey, PURPOSE, token, Claims)
  if (claims === undefined || claims.e <= now || claims.e > now + STREAM_READ_SECONDS) return undefined
  return { workspaceId: claims.w, chat: claims.c, tier: claims.t, epoch: claims.n, expiresAt: claims.e }
}

/** Where a reader reads: `/streams/<token>` on the deployment's own origin. */
export const streamReadUrl = (appUrl: string, token: string): string => `${new URL(appUrl).origin}/streams/${token}`
