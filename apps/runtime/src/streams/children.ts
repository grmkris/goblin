import type { AgentEvent, EntryRecord, SnapshotEvent } from '@earendil-works/pi-durable'
import { type AguiEvent, EventType } from '@goblin/contracts'
import {
  type ChildSent,
  type StreamCursor,
  type Translation,
  childClosed,
  reconcile,
  startCursor,
  translate,
} from './agui.ts'
import { type ChildEnd, type ChildInfo, attribute, endedEvent, startedEvent } from './lifecycle.ts'

// The work of a chat's children (a Persona's fork, a subagent: docs/architecture/streams.md) in the chat's own stream:
// each child's events translated over its own cursor, kept in its parent's, and carried under its `subagentRunId`
// between its SUBAGENT_STARTED and its end. Pure, like the translator: the producer says when a child starts and how
// it ends (a Persona's answer ends its fork's work in `agui.ts`), and hands over the child's batches and snapshots.

/**
 * Where a child's events are carried from: past entry `after` when it is given (a Persona's work from its prompt on),
 * else from its run in flight; with its watch's snapshot, what the snapshot holds past there is carried at once.
 */
export type ChildFrom = { readonly snapshot?: SnapshotEvent | undefined; readonly after?: number | undefined }

/** A child's batch as its parent's stream carries it, the cursor after it, and how a run of the child ended in it. */
export type ChildTranslation = Translation & { readonly ended?: ChildEnd | undefined }

/** The chats of the children whose work `cursor` carries now. */
export const childrenOf = (cursor: StreamCursor): readonly string[] => Object.keys(cursor.children ?? {})

/** The entry a child's run in flight began at: its newest input among its own entries (a fork's history is not). */
const runInput = (chat: string, entries: readonly EntryRecord[]): EntryRecord | undefined =>
  entries.findLast((entry) => entry.kind === 'pi.user' && String(entry.conversationId) === chat)

/**
 * A child's cursor before what its parent's stream carries of it: before its run in flight (a reader sees the run so
 * far), else past everything it has (a fork's inherited history, a subagent's earlier jobs).
 */
function baseOf(chat: string, { snapshot, after }: ChildFrom): StreamCursor {
  if (after !== undefined || snapshot === undefined) return { ...startCursor(chat), lastEntryId: after ?? 0 }
  const { entries, run } = snapshot
  const input = run === undefined ? undefined : runInput(chat, entries)
  const newest = Math.max(0, ...entries.map(({ id }) => Number(id)))
  return { ...startCursor(chat), lastEntryId: input === undefined ? newest : Number(input.id) - 1 }
}

/** `cursor` with `child`'s entry replaced, or removed when it is undefined. */
function withChild(cursor: StreamCursor, chat: string, child: ChildSent | undefined): StreamCursor {
  const children = { ...cursor.children }
  if (child === undefined) delete children[chat]
  else children[chat] = child
  return { ...cursor, children: Object.keys(children).length === 0 ? undefined : children }
}

/**
 * The child begins in its parent's stream: SUBAGENT_STARTED, then what it has of its run in flight, from its watch's
 * snapshot. A child carried already is caught up from the snapshot instead, without starting again.
 */
export function childStarted(cursor: StreamCursor, child: ChildInfo, from: ChildFrom): Translation {
  const { chat, ...info } = child
  const known = cursor.children?.[chat]
  if (known !== undefined)
    return from.snapshot === undefined ? { events: [], cursor } : childCaughtUp(cursor, chat, from.snapshot)
  const base = baseOf(chat, from)
  const caught = from.snapshot === undefined ? { events: [], cursor: base } : reconcile(base, from.snapshot)
  return {
    events: [startedEvent(child), ...attribute(chat, caught.events)],
    cursor: withChild(cursor, chat, { ...info, cursor: caught.cursor }),
  }
}

/** A carried child caught up from a snapshot of its chat: what happened since its cursor, nothing twice. */
function childCaughtUp(cursor: StreamCursor, chat: string, snapshot: SnapshotEvent): Translation {
  const child = cursor.children?.[chat]
  if (child === undefined) return { events: [], cursor }
  const caught = reconcile(child.cursor, snapshot)
  return {
    events: attribute(chat, caught.events),
    cursor: withChild(cursor, chat, { ...child, cursor: caught.cursor }),
  }
}

/** How a child's own run ended, as its end in its parent's stream: done, waiting for a person, failed or stopped. */
function runEnd(event: AguiEvent): ChildEnd | undefined {
  if (event.type === EventType.RUN_ERROR)
    return { outcome: 'failed', code: event.code ?? 'run_error', message: event.message }
  if (event.type !== EventType.RUN_FINISHED) return undefined
  if (event.outcome?.type === 'cancelled') return { outcome: 'stopped' }
  return { outcome: event.outcome?.type === 'interrupt' ? 'suspended' : 'success' }
}

/**
 * One of a child's batches in its parent's stream, over the child's own cursor, and how a run of the child ended in it
 * (a subagent's work is its runs; a Persona's ends with its answer). A child not carried gives nothing.
 */
export function childEvents(cursor: StreamCursor, chat: string, events: readonly AgentEvent[]): ChildTranslation {
  const child = cursor.children?.[chat]
  if (child === undefined) return { events: [], cursor }
  const translated = translate(child.cursor, events)
  return {
    events: attribute(chat, translated.events),
    cursor: withChild(cursor, chat, { ...child, cursor: translated.cursor }),
    ended: translated.events.flatMap((event) => runEnd(event) ?? []).at(-1),
  }
}

/** The child's work ends in its parent's stream: what it left open closes, then SUBAGENT_FINISHED or SUBAGENT_ERROR. */
export function childEnded(cursor: StreamCursor, chat: string, end: ChildEnd): Translation {
  const child = cursor.children?.[chat]
  if (child === undefined) return { events: [], cursor }
  return {
    events: [...childClosed(chat, child), endedEvent({ ...child, chat }, end)],
    cursor: withChild(cursor, chat, undefined),
  }
}

/**
 * How a child's work is carried: a subagent's work is its runs (`runs`), so a run that begins starts it, past `after`
 * (the newest entry its watch delivered before), and the run's end ends it; a Persona's starts and ends with its
 * invocation (the producer, and its answer in `agui.ts`).
 */
export type ChildRule = { readonly runs: boolean; readonly after: number }

/** Whether a child's batch begins a run: Pi announces it, or an overflow's snapshot finds one in flight. */
const begins = (events: readonly AgentEvent[]): boolean =>
  events.some((event) => event.type === 'run_start' || (event.type === 'snapshot' && event.run !== undefined))

/** One of a child's batches in its parent's stream, the child started or ended by its runs when they are its work. */
export function childBatch(
  cursor: StreamCursor,
  child: ChildInfo,
  events: readonly AgentEvent[],
  rule: ChildRule,
): Translation {
  const { chat } = child
  const starts = rule.runs && cursor.children?.[chat] === undefined && begins(events)
  const started = starts ? childStarted(cursor, child, { after: rule.after }) : { events: [], cursor }
  const batch = childEvents(started.cursor, chat, events)
  const ended =
    rule.runs && batch.ended !== undefined
      ? childEnded(batch.cursor, chat, batch.ended)
      : { events: [], cursor: batch.cursor }
  return { events: [...started.events, ...batch.events, ...ended.events], cursor: ended.cursor }
}

/**
 * A child as a new watch of its chat finds it (`from.snapshot`): one not carried starts with what it did from `from`
 * on (a subagent only while a run is in flight), one carried catches up, and a subagent's run that ended meanwhile ends
 * it.
 */
export function childFound(
  cursor: StreamCursor,
  child: ChildInfo,
  from: ChildFrom & { readonly snapshot: SnapshotEvent },
  runs: boolean,
): Translation {
  const { snapshot } = from
  if (cursor.children?.[child.chat] !== undefined) return childBatch(cursor, child, [snapshot], { runs, after: 0 })
  return !runs || snapshot.run !== undefined ? childStarted(cursor, child, from) : { events: [], cursor }
}
