// A chat's Pi snapshot and a page of its raw history, for the integration cases only: what the owner endpoints answered
// before the chat's AG-UI stream replaced them (docs/architecture/streams.md). Each test agent serves them at
// `/test/snapshot/<chat>` and `/test/history/<chat>?before=`.
import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { SessionId, chatRow } from '../../src/chats/directory.ts'
import { BACKGROUND, conversationId, entryId } from '../../src/pi/context.ts'

/** The chat a test agent's snapshot or history lever names, or none for any other path. */
export const leverChat = (path: string): string | undefined =>
  /^\/test\/(?:snapshot|history)\/(\d{1,12})$/u.exec(path)?.[1]

/**
 * `chat`'s Pi snapshot as JSON, or a page of its raw entries before `?before=` (oldest first), as the lever asks; 404
 * for a chat not registered yet.
 */
export async function leverResponse(harness: PiHarness, storage: DurableObjectStorage, url: URL, chat: string) {
  const stored = chatRow(drizzle(storage), chat)?.piSession
  if (stored === undefined || stored === null) return Response.json({ error: 'not_registered' }, { status: 404 })
  const session = SessionId(stored)
  if (url.pathname.startsWith('/test/history/')) {
    const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
    const before = Number(url.searchParams.get('before') ?? 2 ** 31)
    const page = await conversation?.entries({ maxEntryId: entryId(before - 1) }, 50, undefined, BACKGROUND)
    return Response.json({ entries: page?.items.toReversed() ?? [], more: page?.next !== undefined })
  }
  const stream = await harness.session(session).events()
  const { snapshot } = stream
  await stream.stop()
  return Response.json(snapshot)
}
