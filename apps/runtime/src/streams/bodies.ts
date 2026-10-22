import type { SnapshotEvent } from '@earendil-works/pi-durable'
import { type AguiEvent, CustomName, EventType, type StreamTier } from '@goblin/contracts'
import { Predicate } from 'effect'
import { type StreamCursor, type Translation, open } from './agui.ts'
import { forTier } from './tiers.ts'

// The bytes a chat's stream is written in: JSON arrays of AG-UI events, each one append. A stream object takes up to
// ~1.9 MB per append, so events are split into bodies well under it, and an epoch opens with as many of the chat's
// newest entries as fit in one.

/** One append's body, at most. */
const BODY_BYTES = 512 * 1024
/** How many of a chat's newest entries an epoch opens with, when they fit. */
const WINDOW = 50

const encoder = new TextEncoder()
/** A body's size as the stream counts it. */
export const bytesOf = (body: string): number => encoder.encode(body).length

/** Events that end something a reader waits for: they go out at once rather than with the next 250 ms. */
const BOUNDARIES: ReadonlySet<EventType> = new Set([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.TEXT_MESSAGE_END,
  EventType.MESSAGES_SNAPSHOT,
  EventType.STATE_SNAPSHOT,
  EventType.CUSTOM,
])
export const isBoundary = (event: AguiEvent): boolean => BOUNDARIES.has(event.type)

/** A run's end, after which a stream may move to a new epoch. */
export const isRunEnd = (event: AguiEvent): boolean =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR

/**
 * `event` small enough to append: a tool result too large loses its details first; anything still too large is left
 * out (the transcript keeps it; a reader sees the rest of the run).
 */
function bounded(event: AguiEvent): AguiEvent | undefined {
  if (bytesOf(JSON.stringify(event)) <= BODY_BYTES) return event
  if (event.type !== EventType.TOOL_CALL_RESULT || !Predicate.isReadonlyObject(event.metadata)) return undefined
  const { metadata: _metadata, ...plain } = event
  return bytesOf(JSON.stringify(plain)) <= BODY_BYTES ? plain : undefined
}

/** `events` as append bodies, in order, each a JSON array under the bound; none for no events. */
export function bodiesOf(events: readonly AguiEvent[]): string[] {
  const bodies: string[] = []
  let current: string[] = []
  let size = 2
  for (const event of events.flatMap((each) => bounded(each) ?? [])) {
    const json = JSON.stringify(event)
    const added = bytesOf(json) + 1
    if (current.length > 0 && size + added > BODY_BYTES) {
      bodies.push(`[${current.join(',')}]`)
      current = []
      size = 2
    }
    current.push(json)
    size += added
  }
  if (current.length > 0) bodies.push(`[${current.join(',')}]`)
  return bodies
}

/** The first events of an epoch in `tier`: `open`, with fewer of the newest entries until its snapshot fits a body. */
export function opening(chat: string, snapshot: SnapshotEvent, tier: StreamTier): Translation {
  for (let window = WINDOW; ; window = Math.floor(window / 2)) {
    const opened = open(chat, snapshot, { window })
    const events = forTier(opened.events, tier)
    const [messages] = events
    if (window <= 1 || messages === undefined || bytesOf(JSON.stringify(messages)) <= BODY_BYTES)
      return { events, cursor: opened.cursor }
  }
}

/** The last append of an epoch: the chat goes on in `epoch`. */
export const movedBody = (epoch: number): string =>
  JSON.stringify([{ type: EventType.CUSTOM, name: CustomName.streamMoved, value: { epoch } }])

/** The cursor format a stream row stores; a row in any other is out of step and its stream moves on. */
const CURSOR_VERSION = 1

/** A cursor as a row stores it. */
export const cursorJson = (cursor: StreamCursor): string => JSON.stringify({ v: CURSOR_VERSION, cursor })

/** The cursor a row stores, when this version wrote it. */
export function storedCursor(json: string): StreamCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Predicate.isReadonlyObject(parsed) || parsed.v !== CURSOR_VERSION || !Predicate.isObject(parsed.cursor))
      return undefined
    // SAFETY: only `cursorJson` writes this column, and a row of this version holds a cursor this code made.
    return parsed.cursor as StreamCursor
  } catch {
    // expected: a row that is not JSON is out of step like one of another version
    return undefined
  }
}
