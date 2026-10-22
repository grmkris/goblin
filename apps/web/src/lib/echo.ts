// What the owner just sent, shown at once. The stream confirms a message when the server has committed it, which is
// quick, but a send over a slow link or to a busy agent would otherwise show nothing until then. The echo is dropped for
// the server's own entry when that arrives, and the entry takes the echo's React key, so the row never remounts.
import type { ChatMessage } from './chat-messages.ts'
import type { ConversationProjection } from './agui/reducer.ts'

/**
 * A message sent and not yet read back: its own id (the row's React key), its words, the newest entry before it, and
 * who sent it (their user ID), since in a workspace of several people (ADR 0094) another's message may come first.
 */
export type Echo = {
  readonly id: string
  readonly text: string
  readonly after: number
  readonly by?: string | undefined
}

/** The entry number a message's id starts with (`"12:0"` is entry 12). */
const entryOf = (id: string): number => Number.parseInt(id, 10)

/**
 * Whether a message sent now starts a turn on its own. While a turn runs, or other messages wait, a send is queued and
 * shows in the queue until its turn comes; echoing it in the transcript would put it out of order.
 */
export const startsTurn = (projection: ConversationProjection): boolean =>
  !projection.running && projection.inbox.length === 0

/**
 * The message the stream has delivered for `echo`: the first of its sender's after the entry it was sent behind (one
 * with no member is theirs too: a workspace of one marks none).
 */
export function delivered(echo: Echo, messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.find(
    (message) =>
      message.role === 'user' &&
      message.author === undefined &&
      (message.member === undefined || message.member.userId === echo.by) &&
      entryOf(message.id) > echo.after,
  )
}
