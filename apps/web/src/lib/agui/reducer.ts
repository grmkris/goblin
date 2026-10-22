// A chat's AG-UI events (docs/architecture/streams.md) as the browser follows it: the messages committed so far, the
// answer in flight, the tools running, the queue and the run's progress, and the children working in it (Personas'
// forks, subagents), as one projection the transcript and the composer read. One `Projector` per followed chat keeps
// what the events built; every batch answers a new projection.
import type { PersonaAvatar, QueueItem } from '@goblin/contracts'
import type { ChatMessage } from '../chat-messages.ts'
import { identifier, isNumber, isString, record, records, text } from '../values.ts'
import { type Wire, chatMessages, entriesOf, marksOf, reasoningOwner } from './messages.ts'

/** A tool running in the current turn. `startedAt` is when this browser saw it start (the stream carries no time). */
export type LiveTool = {
  readonly callId: string
  readonly name: string
  readonly status: 'running' | 'done'
  readonly output: string
  readonly args: Record<string, unknown>
  readonly startedAt?: number
}
/**
 * When this browser saw a tool start and end, by call id. Kept after the run ends, when the live tools are cleared, so a
 * row's time does not change then.
 */
export type ToolTimes = { readonly startedAt: number; readonly endedAt?: number }
const TOOL_TIMES_KEPT = 200

/** One queued input, by its id and how it waits. */
type Queued = { readonly id: number; readonly mode: 'steer' | 'followUp' }

/**
 * A child working in the chat now (a Persona answering in its fork, a subagent's run), from its SUBAGENT_STARTED to its
 * end: its `subagentRunId`, its name, a Persona's id and avatar, and what its answer in flight says so far. Its own
 * events stay with it and never enter the transcript; its answer arrives as a message of the chat's own.
 */
export type LiveChild = {
  readonly id: string
  readonly name: string
  readonly persona?: { readonly id: number; readonly avatar: PersonaAvatar } | undefined
  readonly partial: string
}

export type ConversationProjection = {
  /** The committed messages, without the entries a later entry leaves out. */
  readonly messages: readonly ChatMessage[]
  readonly tools: readonly LiveTool[]
  /** What this browser saw of the tools' times (`ToolTimes`). */
  readonly toolTimes?: ReadonlyMap<string, ToolTimes>
  readonly running: boolean
  readonly partial: string
  /** The in-flight message's thinking so far. */
  readonly partialReasoning: string
  /**
   * When the in-flight message started, the same on the committed message, so its rows keep one React key from the
   * first token to the commit and an open Thoughts stays open.
   */
  readonly partialAt?: number | undefined
  readonly progress: string
  readonly inbox: readonly Queued[]
  /** The queued inputs with what each says (`/queue`). */
  readonly queued: readonly QueueItem[]
  /** The entries a Thread may start at (ADR 0034). */
  readonly branchable: ReadonlySet<number>
  /** The entries a later entry leaves out of the chat (a turn moved to a Thread): older pages hide them too. */
  readonly omitted: ReadonlySet<number>
  /** The newest entry the stream carried; a message sent now comes after it. */
  readonly newestEntry: number
  /** The entry older history is read before, a page at a time; none when the snapshot starts at the beginning. */
  readonly historyBefore?: number | undefined
  /** The children working in the chat now, in the order they started. */
  readonly children: readonly LiveChild[]
}

export const queuedProgress = (queuedCount: number): string =>
  `${queuedCount} queued ${queuedCount === 1 ? 'message' : 'messages'}`

/** What the committed messages give the projection; the same objects until a message is committed. */
type Derived = Pick<ConversationProjection, 'messages' | 'branchable' | 'omitted' | 'newestEntry'>

/** A message the stream is still writing: its start, and its words so far. */
type Building = { readonly start: Wire; text: string }

/** The calls asked for so far: each one's name, its arguments once whole, and the message that asked. */
type Call = { readonly name: string; args?: string; readonly parent?: string }

/** `wire` with its goblin marks and those of `more`, the later ones winning. */
const withMarks = (wire: Wire, more: Wire): Wire => {
  const marks = { ...record(record(wire.metadata)?.goblin), ...record(record(more.metadata)?.goblin) }
  return Object.keys(marks).length === 0 ? wire : { ...wire, metadata: { goblin: marks } }
}

/** A tool's output after one update: replaced, or trimmed at the front and appended to. */
function progressed(output: string, update: unknown): string {
  const change = record(update)
  if (change === undefined) return output
  if (isString(change.set)) return change.set
  const trim = isNumber(change.trimStart) ? change.trimStart : 0
  return output.slice(trim) + (isString(change.append) ? change.append : '')
}

/** A child's state as its events built it: who it is, and its answer in flight. */
type Child = { readonly view: Omit<LiveChild, 'partial'>; answer?: string | undefined; partial: string }

/** The child an event belongs to: `subagentRunId` on any event but a child's lifecycle, which is its parent's. */
const childOf = (event: Wire): string | undefined =>
  isString(event.subagentRunId) && !identifier(event.type).startsWith('SUBAGENT_') ? event.subagentRunId : undefined

/** A child as its SUBAGENT_STARTED names it. */
function startedChild(event: Wire): Child {
  const persona = marksOf(event).persona
  return {
    view: {
      id: identifier(event.subagentRunId),
      name: identifier(event.name),
      ...(persona === undefined ? {} : { persona: { id: persona.id, avatar: persona.avatar } }),
    },
    partial: '',
  }
}

/** The followed chat's projection, built from its events in order. */
export class Projector {
  #committed: Wire[] = []
  readonly #children = new Map<string, Child>()
  readonly #building = new Map<string, Building>()
  readonly #calls = new Map<string, Call>()
  #tools: LiveTool[] = []
  #times = new Map<string, ToolTimes>()
  #running = false
  #before: number | undefined
  #state: Record<string, unknown> = {}
  /** What the committed messages give the transcript, kept while they stay the same (text streams past them). */
  #derived: { readonly from: readonly Wire[]; readonly value: Derived } | undefined

  /** The projection after `events`; `now` stamps tools that start in them. */
  apply(events: readonly unknown[], now: number): ConversationProjection {
    for (const event of records(events)) this.#apply(event, now)
    return this.#projection()
  }

  #apply(event: Wire, now: number): void {
    const child = childOf(event)
    if (child !== undefined) return this.#childEvent(child, event)
    switch (event.type) {
      case 'MESSAGES_SNAPSHOT':
        return this.#snapshot(event)
      case 'STATE_SNAPSHOT':
        this.#state = record(event.snapshot) ?? {}
        return
      case 'STATE_DELTA':
        return this.#patch(event.delta)
      case 'RUN_STARTED':
        this.#running = true
        return
      case 'RUN_FINISHED':
      case 'RUN_ERROR':
        return this.#ended()
      case 'TEXT_MESSAGE_START':
      case 'REASONING_MESSAGE_START':
        this.#building.set(identifier(event.messageId), { start: event, text: '' })
        return
      case 'TEXT_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CONTENT':
        return this.#append(event)
      case 'TEXT_MESSAGE_END':
      case 'REASONING_MESSAGE_END':
        return this.#commitBuilt(event)
      default:
        return this.#applyTools(event, now)
    }
  }

  /** A child starts or ends its work: its own events are kept with it until then. */
  #lifecycle(event: Wire): void {
    const id = identifier(event.subagentRunId)
    if (event.type === 'SUBAGENT_STARTED') this.#children.set(id, startedChild(event))
    else this.#children.delete(id)
  }

  /** One of a child's own events: what its answer in flight says; everything else of it stays out of the chat. */
  #childEvent(id: string, event: Wire): void {
    const child = this.#children.get(id)
    if (child === undefined) return
    if (event.type === 'TEXT_MESSAGE_START' && event.role === 'assistant') {
      child.answer = identifier(event.messageId)
      child.partial = ''
    } else if (event.type === 'TEXT_MESSAGE_CONTENT' && event.messageId === child.answer && isString(event.delta))
      child.partial += event.delta
  }

  /** Tool calls, their progress and results, the entries the app draws, and the children's lifecycle. */
  #applyTools(event: Wire, now: number): void {
    switch (event.type) {
      case 'SUBAGENT_STARTED':
      case 'SUBAGENT_FINISHED':
      case 'SUBAGENT_ERROR':
        return this.#lifecycle(event)
      case 'TOOL_CALL_START':
        return this.#called(event)
      case 'TOOL_CALL_ARGS':
        return this.#argued(event)
      case 'CUSTOM':
        if (event.name === 'goblin.tool_progress') this.#progress(record(event.value) ?? {}, now)
        return
      case 'TOOL_CALL_RESULT':
        return this.#result(event, now)
      case 'ACTIVITY_SNAPSHOT':
        return this.#commit({
          id: event.messageId,
          role: 'activity',
          activityType: event.activityType,
          content: event.content,
          ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
        })
      default:
        return undefined
    }
  }

  /**
   * A connection's opening: the messages it starts from replace what was built, and nothing runs until it says so
   * (the children working are started again after it).
   */
  #snapshot(event: Wire): void {
    this.#committed = records(event.messages)
    this.#building.clear()
    this.#calls.clear()
    this.#tools = []
    this.#running = false
    this.#children.clear()
    this.#before = marksOf(event).before
  }

  /** RFC 6902 replacements and removals of the STATE document's members. */
  #patch(delta: unknown): void {
    for (const op of records(delta)) {
      const member = isString(op.path) ? op.path.slice(1) : ''
      if (member === '' || member.includes('/')) continue
      if (op.op === 'remove') delete this.#state[member]
      else if (op.op === 'replace' || op.op === 'add') this.#state[member] = op.value
    }
  }

  /** A run ended: nothing runs or streams any more (an answer cut short was ended before it). */
  #ended(): void {
    this.#running = false
    this.#tools = []
    this.#building.clear()
    this.#calls.clear()
  }

  #append(event: Wire): void {
    const built = this.#building.get(identifier(event.messageId))
    if (built !== undefined && isString(event.delta)) built.text += event.delta
  }

  /** A streamed message ends: it is committed with what it said and the marks of its end, and the calls it asked for. */
  #commitBuilt(event: Wire): void {
    const id = identifier(event.messageId)
    const built = this.#building.get(id)
    if (built === undefined) return
    this.#building.delete(id)
    const { start } = built
    const role = start.type === 'REASONING_MESSAGE_START' ? 'reasoning' : identifier(start.role) || 'assistant'
    const calls = this.#callsOf(id)
    this.#commit(
      withMarks(
        {
          id,
          role,
          content: built.text,
          ...(isString(start.name) && { name: start.name }),
          ...(calls.length > 0 && { toolCalls: calls }),
          ...(start.metadata === undefined ? {} : { metadata: start.metadata }),
        },
        event,
      ),
    )
  }

  /** The tool calls message `id` asked for, as AG-UI writes them. */
  #callsOf(id: string) {
    return [...this.#calls]
      .filter(([, call]) => call.parent === id)
      .map(([callId, call]) => ({
        id: callId,
        type: 'function',
        function: { name: call.name, arguments: call.args ?? '' },
      }))
  }

  /** Adds `wire`, or replaces the message with its id. */
  #commit(wire: Wire): void {
    const id = identifier(wire.id)
    const at = this.#committed.findIndex((each) => each.id === id)
    if (at < 0) this.#committed = [...this.#committed, wire]
    else this.#committed = this.#committed.with(at, wire)
  }

  /** A committed message asked for one more call, or a call's arguments became whole: it is written again. */
  #rewrite(parent: string | undefined): void {
    if (parent === undefined || this.#building.has(parent)) return
    const at = this.#committed.findIndex((each) => each.id === parent)
    const message = this.#committed[at]
    if (message !== undefined)
      this.#committed = this.#committed.with(at, { ...message, toolCalls: this.#callsOf(parent) })
  }

  #called(event: Wire): void {
    const id = identifier(event.toolCallId)
    const parent = isString(event.parentMessageId) ? event.parentMessageId : undefined
    this.#calls.set(id, { name: identifier(event.toolCallName), ...(parent !== undefined && { parent }) })
    this.#rewrite(parent)
  }

  #argued(event: Wire): void {
    const callId = identifier(event.toolCallId)
    const call = this.#calls.get(callId)
    if (call === undefined || !isString(event.delta)) return
    call.args = (call.args ?? '') + event.delta
    this.#rewrite(call.parent)
    const args = record(safeJson(call.args))
    if (args !== undefined) this.#tools = this.#tools.map((tool) => (tool.callId === callId ? { ...tool, args } : tool))
  }

  /** The call `callId`: one this run asked for, or one a committed message holds (the snapshot's). */
  #callOf(callId: string): { readonly name: string; readonly args?: string | undefined } | undefined {
    const asked = this.#calls.get(callId)
    if (asked !== undefined) return asked
    for (const message of this.#committed.toReversed()) {
      const fn = record(records(message.toolCalls).find((call) => call.id === callId)?.function)
      if (fn !== undefined)
        return { name: identifier(fn.name), args: isString(fn.arguments) ? fn.arguments : undefined }
    }
    return undefined
  }

  /** A tool started executing (its first progress), or published output. */
  #progress(value: Wire, now: number): void {
    const callId = identifier(value.toolCallId)
    if (value.status === 'running') {
      const call = this.#callOf(callId)
      const args = record(call?.args === undefined ? undefined : safeJson(call.args)) ?? {}
      this.#tools = [
        ...this.#tools.filter((tool) => tool.callId !== callId),
        { callId, name: call?.name ?? '', status: 'running', output: '', args, startedAt: now },
      ]
      this.#time(callId, () => ({ startedAt: now }))
    }
    if (value.output !== undefined)
      this.#tools = this.#tools.map((tool) =>
        tool.callId === callId ? { ...tool, output: progressed(tool.output, value.output) } : tool,
      )
  }

  /** A tool's result: a nested call's ends its live row only; a model-issued call's is the transcript's tool message. */
  #result(event: Wire, now: number): void {
    const callId = identifier(event.toolCallId)
    this.#tools = this.#tools.map((tool) => (tool.callId === callId ? { ...tool, status: 'done' } : tool))
    this.#time(callId, (before) => ({ startedAt: before?.startedAt ?? now, endedAt: now }))
    if (marksOf(event).parentToolCallId !== undefined) return
    this.#commit({
      id: event.messageId,
      role: 'tool',
      toolCallId: callId,
      content: event.content,
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    })
  }

  #time(callId: string, change: (before: ToolTimes | undefined) => ToolTimes): void {
    const next = new Map(this.#times)
    next.set(callId, change(next.get(callId)))
    // Oldest first: a map iterates in insertion order.
    for (const old of [...next.keys()].slice(0, Math.max(0, next.size - TOOL_TIMES_KEPT))) next.delete(old)
    this.#times = next
  }

  /** The answer in flight: its words, when it began, and its thinking so far (which starts before its words). */
  #inFlight() {
    const committed = new Set(this.#committed.map((message) => identifier(message.id)))
    const answer = [...this.#building.values()].find(
      ({ start }) =>
        start.type === 'TEXT_MESSAGE_START' && start.role === 'assistant' && marksOf(start).persona === undefined,
    )
    const thinking = [
      ...this.#committed.filter((message) => message.role === 'reasoning'),
      ...[...this.#building.values()]
        .filter(({ start }) => start.type === 'REASONING_MESSAGE_START')
        .map(({ start, text: words }) => ({
          id: start.messageId,
          role: 'reasoning',
          content: words,
          metadata: start.metadata,
        })),
    ].filter((message) => {
      const owner = reasoningOwner(identifier(message.id))
      return owner !== undefined && !committed.has(owner)
    })
    const at = marksOf(answer?.start ?? thinking.at(-1) ?? {}).at
    const reasoning = thinking
      .map((message) => text(message.content).trim())
      .filter((thought) => thought !== '')
      .join('\n\n')
    return { text: answer?.text ?? '', reasoning, at }
  }

  #progressOf(inbox: readonly Queued[]): string {
    const generation = record(this.#state.generation)
    if (record(generation?.retry) !== undefined) return 'Waiting for model retry'
    if (record(generation?.deferred) !== undefined) return 'Waiting for deferred model response'
    if (this.#running) return 'Agent is working'
    return inbox.length > 0 ? queuedProgress(inbox.length) : 'Ready'
  }

  #derive(): Derived {
    if (this.#derived?.from === this.#committed) return this.#derived.value
    const { branchable, omitted, newest } = entriesOf(this.#committed)
    const value = { messages: chatMessages(this.#committed, omitted), branchable, omitted, newestEntry: newest }
    this.#derived = { from: this.#committed, value }
    return value
  }

  #projection(): ConversationProjection {
    const queued = queueOf(this.#state.queue)
    const inbox = queued.map(({ id, mode }) => ({ id, mode }))
    const flight = this.#inFlight()
    return {
      ...this.#derive(),
      tools: this.#tools,
      toolTimes: this.#times,
      running: this.#running,
      partial: flight.text,
      partialReasoning: flight.reasoning,
      partialAt: flight.at,
      progress: this.#progressOf(inbox),
      inbox,
      queued,
      historyBefore: this.#before,
      children: [...this.#children.values()].map(({ view, partial }) => ({ ...view, partial })),
    }
  }
}

/** JSON text as a value, or none when it is not JSON (arguments still arriving). */
function safeJson(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    // expected: arguments that are not whole JSON yet read as none
    return undefined
  }
}

/** The STATE document's `/queue`: the inputs that wait, each with what it says when the stream says it. */
function queueOf(value: unknown): QueueItem[] {
  return records(value).flatMap((item) => {
    if (!isNumber(item.id) || (item.mode !== 'steer' && item.mode !== 'followUp')) return []
    // SAFETY: the stream's `/queue` is `QueueItem` (contracts/agui/state.ts); its id and mode were just checked.
    return [item as QueueItem]
  })
}
