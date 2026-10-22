import type { SnapshotEvent } from '@earendil-works/pi-durable'
import { type AguiEvent, EventType } from '@goblin/contracts'
import { Predicate } from 'effect'
import { type Hints, type Translation, open } from './agui.ts'

// How large a chat's stream lets one event be: each is one server-sent frame, and a connection opens with as many of
// the chat's newest entries as fit in one.

/** One event's JSON, at most. */
const EVENT_BYTES = 512 * 1024
/** How many of a chat's newest entries a connection opens with, when they fit. */
const WINDOW = 50

const encoder = new TextEncoder()
/** `value`'s size as JSON. */
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

/**
 * `event` small enough to send: a tool result too large loses its details first; anything still too large is left
 * out (the transcript keeps it; a reader sees the rest of the run).
 */
export function bounded(event: AguiEvent): AguiEvent | undefined {
  if (bytesOf(event) <= EVENT_BYTES) return event
  if (event.type !== EventType.TOOL_CALL_RESULT || !Predicate.isReadonlyObject(event.metadata)) return undefined
  const { metadata: _metadata, ...plain } = event
  return bytesOf(plain) <= EVENT_BYTES ? plain : undefined
}

/** A connection's first events: `open`, with fewer of the newest entries until its snapshot fits one event. */
export function opening(chat: string, snapshot: SnapshotEvent, hints: Hints = {}): Translation {
  for (let window = WINDOW; ; window = Math.floor(window / 2)) {
    const opened = open(chat, snapshot, { window, hints })
    const [messages] = opened.events
    if (window <= 1 || messages === undefined || bytesOf(messages) <= EVENT_BYTES) return opened
  }
}
