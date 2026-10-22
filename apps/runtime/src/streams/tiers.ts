import {
  ANSWERS_STATE,
  type AguiEvent,
  type AguiMessage,
  CustomName,
  EventType,
  type StreamTier,
} from '@goblin/contracts'
import { Predicate } from 'effect'

// What each tier of a chat's stream carries (docs/architecture/streams.md), and the merging of consecutive deltas the
// producer appends as one.

/** The events only the `full` tier carries: reasoning, tool calls and their results, steps, raw provider events. */
const FULL_ONLY: ReadonlySet<EventType> = new Set([
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.RAW,
])

/** A subagent's lifecycle, which `answers` keeps of everything a subagent does. */
const LIFECYCLE: ReadonlySet<EventType> = new Set([
  EventType.SUBAGENT_STARTED,
  EventType.SUBAGENT_FINISHED,
  EventType.SUBAGENT_ERROR,
])

/** A STATE path the `answers` tier carries: a member it keeps, or a path inside one. */
const answersPath = (path: string): boolean =>
  ANSWERS_STATE.some((key) => path === `/${key}` || path.startsWith(`/${key}/`))

/** The `answers` members of a STATE document. */
function answersState(snapshot: unknown): Record<string, unknown> {
  if (!Predicate.isReadonlyObject(snapshot)) return {}
  return Object.fromEntries(ANSWERS_STATE.flatMap((key) => (key in snapshot ? [[key, snapshot[key]]] : [])))
}

/** A snapshot message as `answers` has it: no reasoning or tool messages, no tool calls, nothing a subagent wrote. */
function answersMessage(message: AguiMessage): AguiMessage[] {
  if (message.role === 'reasoning' || message.role === 'tool' || message.subagentRunId !== undefined) return []
  if (message.role !== 'assistant' || message.toolCalls === undefined) return [message]
  const { toolCalls: _calls, ...rest } = message
  return [rest]
}

/** One event as the `answers` tier carries it: as it is, cut down to what the tier carries, or not at all. */
function answersEvent(event: AguiEvent): AguiEvent[] {
  if (FULL_ONLY.has(event.type)) return []
  if ('subagentRunId' in event && event.subagentRunId !== undefined && !LIFECYCLE.has(event.type)) return []
  if (event.type === EventType.CUSTOM) return event.name === CustomName.toolProgress ? [] : [event]
  if (event.type === EventType.STATE_SNAPSHOT) return [{ ...event, snapshot: answersState(event.snapshot) }]
  if (event.type === EventType.MESSAGES_SNAPSHOT)
    return [{ ...event, messages: event.messages.flatMap(answersMessage) }]
  if (event.type !== EventType.STATE_DELTA) return [event]
  const delta = event.delta.filter((op) => answersPath(op.path) && (!('from' in op) || answersPath(op.from)))
  return delta.length === 0 ? [] : [{ ...event, delta }]
}

/**
 * `events` as `tier` carries them. `full` carries everything. `answers` carries the run lifecycle, the text messages
 * of people and agents, activities, subagent lifecycle, `goblin.stream.moved` and `/attention`; it drops reasoning,
 * tool calls and results, steps, tool progress, the other STATE members, and whatever a subagent does but start and
 * finish (its answer reaches the parent as a message of its own).
 */
export const forTier = (events: readonly AguiEvent[], tier: StreamTier): AguiEvent[] =>
  tier === 'full' ? [...events] : events.flatMap(answersEvent)

type ContentDelta = Extract<
  AguiEvent,
  { readonly type: EventType.TEXT_MESSAGE_CONTENT | EventType.REASONING_MESSAGE_CONTENT }
>

/** `event` when it is a plain content delta (nothing on it but its message and text), which merges with its kind. */
const contentDelta = (event: AguiEvent): ContentDelta | undefined =>
  (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.REASONING_MESSAGE_CONTENT) &&
  event.metadata === undefined &&
  event.timestamp === undefined &&
  event.rawEvent === undefined
    ? event
    : undefined

/** Two deltas of the same kind to the same message, from the same agent. */
const joins = (before: ContentDelta, next: ContentDelta): boolean =>
  before.type === next.type && before.messageId === next.messageId && before.subagentRunId === next.subagentRunId

/**
 * Consecutive content deltas of one message merged into one, text and reasoning alike: what a reader concatenates is
 * unchanged, and the stream carries fewer events. Anything else between two deltas keeps them apart.
 */
export function coalesce(events: readonly AguiEvent[]): AguiEvent[] {
  const out: AguiEvent[] = []
  for (const event of events) {
    const last = out.at(-1)
    const before = last === undefined ? undefined : contentDelta(last)
    const next = contentDelta(event)
    if (before !== undefined && next !== undefined && joins(before, next))
      out[out.length - 1] = { ...before, delta: before.delta + next.delta }
    else out.push(event)
  }
  return out
}
