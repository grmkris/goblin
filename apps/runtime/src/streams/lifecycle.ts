import {
  type AguiEvent,
  CustomName,
  EventType,
  type GoblinMetadata,
  type InvocationMark,
  type PersonaFailure,
  type PersonaMark,
} from '@goblin/contracts'
import { Predicate } from 'effect'
import { goblin } from './messages.ts'

// A child's part of its parent's stream (docs/architecture/streams.md): a Persona's fork or a subagent works in a chat
// of its own, and its parent's stream carries that work under AG-UI's subagent attribution. `subagentRunId` is the
// child's chat; its lifecycle is SUBAGENT_STARTED and SUBAGENT_FINISHED or SUBAGENT_ERROR, and everything it does in
// between carries `subagentRunId`, with tool call ids its chat's own. Pure event builders, no cursor.

/**
 * Who a child is, as its parent's stream names it: its chat (the `subagentRunId`), its name, and a Persona's mark, which
 * its answer carries too.
 */
export type ChildInfo = {
  readonly chat: string
  readonly name: string
  /** A Persona's: who answers, at which revision, for which operation. */
  readonly persona?: PersonaMark | undefined
}

/**
 * How a child's work ended: done (`success`), or waiting for a person (`suspended`, on the attention items its answer
 * raised), with a Persona's answer entry and its mark as the answer has it; failed, with why; or stopped.
 */
export type ChildEnd =
  | {
      readonly outcome: 'success' | 'suspended'
      readonly entryId?: number
      readonly interrupts?: readonly string[]
      readonly persona?: PersonaMark
    }
  | { readonly outcome: 'failed'; readonly code: string; readonly message: string; readonly reason?: PersonaFailure }
  | { readonly outcome: 'stopped' }

/** A Persona's invocation as its end leaves it, `PersonaInvocationView`'s state and reason. */
const invocationOf = (end: ChildEnd): InvocationMark => {
  if (end.outcome === 'stopped') return { state: 'stopped' }
  if (end.outcome !== 'failed') return { state: 'answered' }
  return { state: 'failed', ...(end.reason === undefined ? {} : { reason: end.reason }) }
}

/** The child begins: its name, and a Persona's mark with its invocation running. */
export const startedEvent = (child: ChildInfo): AguiEvent => ({
  type: EventType.SUBAGENT_STARTED,
  subagentRunId: child.chat,
  name: child.name,
  ...goblin(child.persona === undefined ? {} : { persona: child.persona, invocation: { state: 'running' } }),
})

/** A Persona's marks on its end: its mark (as its answer has it, when it answered) and its invocation. */
function endMarks(child: ChildInfo, end: ChildEnd): GoblinMetadata {
  if (child.persona === undefined) return {}
  const answered = end.outcome === 'success' || end.outcome === 'suspended' ? end.persona : undefined
  return { persona: answered ?? child.persona, invocation: invocationOf(end) }
}

/** The child ends: SUBAGENT_FINISHED, done or waiting for a person, or SUBAGENT_ERROR, failed or stopped. */
export function endedEvent(child: ChildInfo, end: ChildEnd): AguiEvent {
  const subagentRunId = child.chat
  if (end.outcome === 'stopped')
    return {
      type: EventType.SUBAGENT_ERROR,
      subagentRunId,
      code: 'stopped',
      message: 'Stopped.',
      ...goblin(endMarks(child, end)),
    }
  if (end.outcome === 'failed')
    return {
      type: EventType.SUBAGENT_ERROR,
      subagentRunId,
      code: end.code,
      message: end.message,
      ...goblin(endMarks(child, end)),
    }
  const interrupts = end.interrupts ?? []
  return {
    type: EventType.SUBAGENT_FINISHED,
    subagentRunId,
    outcome:
      end.outcome === 'suspended'
        ? { type: 'suspended', ...(interrupts.length === 0 ? {} : { interruptIds: [...interrupts] }) }
        : { type: 'success' },
    ...goblin({ ...(end.entryId === undefined ? {} : { entryId: end.entryId }), ...endMarks(child, end) }),
  }
}

/**
 * What of a child's own translation its parent's stream leaves out: its runs (its lifecycle stands for them), its
 * snapshots and its STATE (the parent's STATE is the parent's).
 */
type Own =
  | EventType.RUN_STARTED
  | EventType.RUN_FINISHED
  | EventType.RUN_ERROR
  | EventType.MESSAGES_SNAPSHOT
  | EventType.STATE_SNAPSHOT
  | EventType.STATE_DELTA
const OWN: ReadonlySet<EventType> = new Set<Own>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.MESSAGES_SNAPSHOT,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
])

/** The events a child's part of its parent's stream carries, each of which AG-UI lets carry `subagentRunId`. */
type Carried = Exclude<AguiEvent, { readonly type: Own }>
const carried = (event: AguiEvent): event is Carried => !OWN.has(event.type)

/** A child's tool call id in its parent's stream: prefixed with its chat, as its message ids are, so it meets no other. */
const childCallId = (chat: string, toolCallId: string): string => `${chat}:${toolCallId}`

/** `metadata.goblin.parentToolCallId` of a child's nested call, its chat's own too; nothing to change without one. */
function withParentCall(chat: string, metadata: Readonly<Record<string, unknown>> | undefined) {
  const marks = metadata?.goblin
  if (metadata === undefined || !Predicate.isReadonlyObject(marks) || !Predicate.isString(marks.parentToolCallId))
    return {}
  return {
    metadata: { ...metadata, goblin: { ...marks, parentToolCallId: childCallId(chat, marks.parentToolCallId) } },
  }
}

/** A running tool's progress, its call its chat's own. */
function progressOf(chat: string, event: Extract<Carried, { readonly type: EventType.CUSTOM }>): Carried {
  const value: unknown = event.value
  if (event.name !== CustomName.toolProgress || !Predicate.isReadonlyObject(value)) return event
  if (!Predicate.isString(value.toolCallId)) return event
  return { ...event, value: { ...value, toolCallId: childCallId(chat, value.toolCallId) } }
}

/** One of a child's events with its tool call ids its chat's own. */
function namespaced(chat: string, event: Carried): Carried {
  if (event.type === EventType.TOOL_CALL_START || event.type === EventType.TOOL_CALL_RESULT)
    return { ...event, toolCallId: childCallId(chat, event.toolCallId), ...withParentCall(chat, event.metadata) }
  if (event.type === EventType.TOOL_CALL_ARGS || event.type === EventType.TOOL_CALL_END)
    return { ...event, toolCallId: childCallId(chat, event.toolCallId) }
  return event.type === EventType.CUSTOM ? progressOf(chat, event) : event
}

/** A child's own events as its parent's stream carries them: attributed to it, its ids its own, its runs left out. */
export const attribute = (chat: string, events: readonly AguiEvent[]): AguiEvent[] =>
  events.flatMap((event): AguiEvent[] => (carried(event) ? [{ ...namespaced(chat, event), subagentRunId: chat }] : []))
