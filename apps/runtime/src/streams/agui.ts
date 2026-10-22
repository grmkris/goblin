import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord, SnapshotEvent, SubmissionRecord } from '@earendil-works/pi-durable'
import {
  type AguiEvent,
  type AttentionItem,
  CustomName,
  EventType,
  type GoblinState,
  type PersonaAnswerData,
  type TokenCounts,
  type ToolProgress,
} from '@goblin/contracts'
import { openAttention, settleAttention } from './attention.ts'
import { type ChildInfo, attribute, endedEvent } from './lifecycle.ts'
import { type MessageSent, applyChange, beginMessage, endMessage, syncBlock } from './live.ts'
import {
  entryMarks,
  entryMessages,
  firstLine,
  goblin,
  messageEvents,
  omittedBy,
  outcomeOf,
  personaAnswer,
  personaMark,
  runIdOf,
  stopOf,
  toolResultId,
} from './messages.ts'
import {
  type QueuedParts,
  addCounts,
  agentView,
  emptyState,
  queueView,
  stateOf,
  tokenCounts,
  usageView,
} from './state.ts'

// A chat's Pi events as AG-UI 1.0 events (docs/architecture/streams.md): a pure translator, no services and no I/O.
// The producer keeps a cursor per reader between calls; `translate` follows Pi's committed batches, `reconcile` catches
// up from a snapshot (a watch that overflowed, or opened again), and `open` starts a reader's connection.

/** The run in flight, as far as the stream followed it. */
type RunSent = {
  readonly id: string
  readonly inputs: readonly number[]
  /** Turns begun, and whether the newest one's step is open. */
  step: number
  stepOpen: boolean
  /** The attention items raised during the run: an `interrupt` outcome carries those still open at its end. */
  readonly raised: string[]
  /** How its newest answer stopped, when not by itself: a failed model call, or a stop. */
  stop?: 'error' | 'aborted' | undefined
  error?: string | undefined
  /** A generation task that faulted: the run ends in RUN_ERROR. */
  failed?: true
  /** Its model calls' tokens by `provider/modelId`. */
  readonly usage: Record<string, TokenCounts>
}

/**
 * Where a chat's stream is: what it carried last (`lastEntryId`), the run and the answer in flight, the operation ids
 * of inputs it saw admitted (by submission id, newest kept), the compaction tasks behind `state.compactions.running`,
 * the STATE document as sent, and the children whose work it carries now (`children.ts`). Plain JSON, kept by the
 * producer for each reader between batches. `translate`, `reconcile` and `open` never change the cursor they are given;
 * they answer a new one.
 */
export type StreamCursor = {
  readonly chat: string
  lastEntryId: number
  run?: RunSent | undefined
  message?: MessageSent | undefined
  operations: Record<string, string>
  compactionTasks: number[]
  state: GoblinState
  /** By child chat (the `subagentRunId`). */
  children?: Record<string, ChildSent> | undefined
}

/** A child whose work the stream carries (started, not ended): who it is, and its own cursor over its own chat. */
export type ChildSent = Omit<ChildInfo, 'chat'> & { cursor: StreamCursor }

/**
 * What the producer knows that Pi's events do not say: what queued inputs say (from `InboxDoc`), and the operation ids
 * of the inputs a snapshot names (its run's, the queue's), which a snapshot does not carry; each by submission id.
 */
export type Hints = {
  readonly queued?: ReadonlyMap<number, QueuedParts>
  readonly operations?: ReadonlyMap<number, string>
}

/** The events to send, and the cursor after them. */
export type Translation = { readonly events: readonly AguiEvent[]; readonly cursor: StreamCursor }

/** How many admitted inputs' operation ids a cursor keeps until their run starts. */
const OPERATIONS_KEPT = 64

/** A stream that carried nothing yet. */
export const startCursor = (chat: string): StreamCursor => ({
  chat,
  lastEntryId: 0,
  operations: {},
  compactionTasks: [],
  state: emptyState(),
})

type Work = { readonly cursor: StreamCursor; readonly out: AguiEvent[]; readonly hints: Hints }
const work = (cursor: StreamCursor, hints: Hints): Work => ({ cursor: structuredClone(cursor), out: [], hints })

/** One member of the STATE document replaced, as an RFC 6902 patch, when it changed. */
function setState<K extends keyof GoblinState>(w: Work, key: K, value: GoblinState[K]): void {
  if (JSON.stringify(w.cursor.state[key]) === JSON.stringify(value)) return
  w.cursor.state[key] = value
  w.out.push({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: `/${key}`, value }] })
}

/**
 * The operation ids the producer read for inputs a snapshot names, kept for their run like those of inputs the stream
 * saw admitted; never for the run the stream already follows.
 */
function hintedOperations(w: Work): void {
  const { operations, run } = w.cursor
  for (const [input, operation] of w.hints.operations ?? [])
    if (!(run?.inputs.includes(input) ?? false)) operations[input] ??= operation
}

/** A run begins: one ended that the stream never saw end first. */
function runStarted(w: Work, inputs: readonly number[]): void {
  if (w.cursor.run !== undefined) runEnded(w, new Map())
  const { chat, operations } = w.cursor
  const id = runIdOf(chat, inputs)
  const named = inputs.flatMap((input) => operations[input] ?? [])
  for (const input of inputs) delete operations[input]
  w.out.push({
    type: EventType.RUN_STARTED,
    threadId: chat,
    runId: id,
    ...goblin(named.length === 0 ? {} : { operations: named }),
  })
  w.cursor.run = { id, inputs: [...inputs], step: 0, stepOpen: false, raised: [], usage: {} }
}

/** A model's tokens as AG-UI counts them: input with the cache reads and writes. */
const aguiUsage = (key: string, counts: TokenCounts) => {
  const slash = key.indexOf('/')
  return {
    provider: slash < 0 ? key : key.slice(0, slash),
    model: slash < 0 ? key : key.slice(slash + 1),
    inputTokens: counts.input + counts.cacheRead + counts.cacheWrite,
    outputTokens: counts.output,
    totalTokens: counts.totalTokens,
    cachedInputTokens: counts.cacheRead,
    cacheWriteInputTokens: counts.cacheWrite,
    ...(counts.reasoning === undefined ? {} : { reasoningTokens: counts.reasoning }),
  }
}

/** Why the run failed, when it did: its answer's model error, a faulted generation, or an input Pi gave up on. */
function runFailure(run: RunSent, inputs: readonly (SubmissionRecord | undefined)[]) {
  if (run.stop === 'error') return { code: 'model_error', message: run.error ?? 'The model call failed.' }
  if (run.failed === true) return { code: 'task_failed', message: 'The run failed.' }
  const given = inputs.find((record) => record?.status === 'unanswered' && record.reason !== 'aborted')
  if (given?.status !== 'unanswered') return undefined
  const detail = typeof given.detail === 'string' ? firstLine(given.detail) : ''
  return { code: given.reason, message: detail === '' ? given.reason : detail }
}

/** How the run ended: failed, stopped, waiting for a person, or done. */
function runOutcome(w: Work, run: RunSent, settled: ReadonlyMap<number, SubmissionRecord>): AguiEvent {
  const usage = Object.entries(run.usage).map(([key, counts]) => aguiUsage(key, counts))
  const spent = usage.length === 0 ? {} : { usage }
  const inputs = run.inputs.map((input) => settled.get(input))
  const failure = runFailure(run, inputs)
  if (failure !== undefined) return { type: EventType.RUN_ERROR, ...failure, ...spent }
  const finished = { type: EventType.RUN_FINISHED, threadId: w.cursor.chat, runId: run.id, ...spent } as const
  const aborted = inputs.some((record) => record?.status === 'unanswered' && record.reason === 'aborted')
  if (run.stop === 'aborted' || aborted) return { ...finished, outcome: { type: 'cancelled' } }
  const interrupts: AttentionItem[] = w.cursor.state.attention.filter(({ id }) => run.raised.includes(id))
  return interrupts.length === 0
    ? { ...finished, outcome: { type: 'success' } }
    : { ...finished, outcome: { type: 'interrupt', interrupts } }
}

/** The run ends: its answer in flight and its step close, then RUN_FINISHED or RUN_ERROR. */
function runEnded(w: Work, settled: ReadonlyMap<number, SubmissionRecord>): void {
  const { run, message } = w.cursor
  if (run === undefined) return
  if (message !== undefined) endMessage(message, w.out)
  w.cursor.message = undefined
  if (run.stepOpen) w.out.push({ type: EventType.STEP_FINISHED, stepName: `turn ${run.step}` })
  setState(w, 'generation', null)
  w.out.push(runOutcome(w, run, settled))
  w.cursor.run = undefined
}

/** An assistant message committed: the one in flight ends with it, or it is written whole. */
function assistantCommitted(w: Work, entry: EntryRecord, message: AssistantMessage): void {
  const entryId = Number(entry.id)
  const { cursor } = w
  if (cursor.message !== undefined && cursor.message.at !== message.timestamp) endMessage(cursor.message, w.out)
  const sent = cursor.message?.at === message.timestamp ? cursor.message : beginMessage(cursor.chat, message.timestamp)
  endMessage(sent, w.out, { message, entryId, marks: entryMarks(entry) })
  cursor.message = undefined
  // A failed attempt Pi retries is committed in the commit that starts its backoff, which the call still waits out.
  if (cursor.state.generation?.retry === undefined) setState(w, 'generation', null)
  const { run } = cursor
  if (run === undefined) return
  const key = `${message.provider}/${message.model}`
  run.usage[key] = addCounts(run.usage[key], tokenCounts(message.usage))
  const stop = stopOf(message)
  run.stop = stop?.reason === 'length' ? undefined : stop?.reason
  run.error = stop?.message
}

/** `/attention` after `entry`, and what it raised during the run. */
function attentionAfter(w: Work, entry: EntryRecord): void {
  const before = w.cursor.state.attention
  const after = settleAttention(w.cursor.chat, before, entry, personaAnswer(entry), outcomeOf(entry))
  for (const item of after) if (!before.some(({ id }) => id === item.id)) w.cursor.run?.raised.push(item.id)
  setState(w, 'attention', after)
}

/**
 * Closes what is still open in a stream: its answer in flight and its step; a run that never ended ends (its
 * RUN_FINISHED, which a child's part of its parent's stream leaves out).
 */
function closeOpen(w: Work): void {
  if (w.cursor.run !== undefined) return runEnded(w, new Map())
  if (w.cursor.message !== undefined) endMessage(w.cursor.message, w.out)
  w.cursor.message = undefined
}

/** A child's work ends in its parent's stream: what it left open closes, then its SUBAGENT_* end. */
export function childClosed(chat: string, child: ChildSent): AguiEvent[] {
  const w = work(child.cursor, {})
  closeOpen(w)
  return attribute(chat, w.out)
}

/** The child chat whose work a Persona's answer ends: its fork, or the one carried for its operation. */
function answeringChild(children: Record<string, ChildSent>, answer: PersonaAnswerData): string | undefined {
  if (answer.fork !== undefined) return Object.hasOwn(children, answer.fork) ? answer.fork : undefined
  return Object.keys(children).find((chat) => {
    const persona = children[chat]?.persona
    return persona?.id === answer.persona && persona.operationId === answer.operationId
  })
}

/**
 * A Persona's answer ends the work of its fork, when the stream carries it: after the answer, SUBAGENT_FINISHED with
 * the answer's entry, suspended on what the answer raised when it waits for the owner.
 */
function childAnswered(w: Work, entry: EntryRecord): void {
  const answer = personaAnswer(entry)
  const { children } = w.cursor
  if (answer === undefined || children === undefined) return
  const chat = answeringChild(children, answer)
  const child = chat === undefined ? undefined : children[chat]
  if (chat === undefined || child === undefined) return
  const entryId = Number(entry.id)
  const interrupts = w.cursor.state.attention.flatMap(({ id, metadata }) =>
    metadata.goblin.entryId === entryId ? [id] : [],
  )
  const outcome = interrupts.length === 0 ? 'success' : 'suspended'
  const end = { outcome, entryId, interrupts, persona: personaMark(answer) } as const
  w.out.push(...childClosed(chat, child), endedEvent({ ...child, chat }, end))
  delete children[chat]
}

/** A committed entry, once: its messages' events, then what it settles or raises, and the child work it ends. */
function entryCommitted(w: Work, entry: EntryRecord): void {
  const id = Number(entry.id)
  if (id <= w.cursor.lastEntryId) return
  w.cursor.lastEntryId = id
  const first = entry.model?.[0]
  if (first?.role === 'assistant' && entry.kind !== 'app.persona') assistantCommitted(w, entry, first)
  else for (const message of entryMessages(w.cursor.chat, entry)) w.out.push(...messageEvents(message, id))
  if (entry.kind === 'pi.compaction') setState(w, 'compactions', { ...w.cursor.state.compactions, failure: null })
  attentionAfter(w, entry)
  childAnswered(w, entry)
}

/** A goblin CUSTOM event: a running tool's progress. */
const progress = (value: ToolProgress): AguiEvent => ({ type: EventType.CUSTOM, name: CustomName.toolProgress, value })

type PiEvent<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

/** A tool starts executing; a nested call (one a running tool made) is opened and given its arguments here. */
function toolStarted(w: Work, event: PiEvent<'tool_execution_start'>): void {
  const { toolCallId, toolName, parentToolCallId } = event
  if (parentToolCallId !== undefined)
    w.out.push(
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: toolName, ...goblin({ parentToolCallId }) },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(event.args) },
      { type: EventType.TOOL_CALL_END, toolCallId },
    )
  w.out.push(progress({ toolCallId, status: 'running' }))
}

/** What a running tool published: its output, details and diagnostics. */
function toolUpdated(w: Work, event: PiEvent<'tool_execution_update'>): void {
  const { toolCallId, output, details, diagnostics } = event
  w.out.push(
    progress({
      toolCallId,
      ...(output === undefined ? {} : { output }),
      ...(details === undefined ? {} : { details }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
  )
}

/** A nested call's result, which never enters the transcript; a model-issued call's result is its entry. */
function toolEnded(w: Work, event: PiEvent<'tool_execution_end'>): void {
  const { toolCallId, parentToolCallId, result } = event
  if (parentToolCallId === undefined || result === undefined) return
  const output = result.structuredOutput
  const content =
    typeof output === 'string'
      ? output
      : output === undefined
        ? result.diagnostics.map(({ message }) => message).join('\n')
        : JSON.stringify(output)
  w.out.push({
    type: EventType.TOOL_CALL_RESULT,
    messageId: toolResultId(w.cursor.chat, toolCallId),
    toolCallId,
    content,
    role: 'tool',
    ...goblin({
      ...(result.details === undefined ? {} : { details: result.details }),
      isError: result.isError,
      parentToolCallId,
    }),
  })
}

/** A compaction starts or ends: the running list, and the failure an ended one leaves. */
function compaction(w: Work, event: PiEvent<'compaction_start' | 'compaction_end'>): void {
  const { compactionTasks, state } = w.cursor
  const running = [...state.compactions.running]
  if (event.type === 'compaction_start') {
    compactionTasks.push(Number(event.taskId))
    running.push({ reason: event.reason, blocking: event.blocking })
    return setState(w, 'compactions', { ...state.compactions, running })
  }
  const index = compactionTasks.indexOf(Number(event.taskId))
  if (index >= 0) {
    compactionTasks.splice(index, 1)
    running.splice(index, 1)
  }
  const failure = event.error === undefined ? state.compactions.failure : { reason: event.reason, error: event.error }
  setState(w, 'compactions', { running, failure })
}

/** A turn of the run: a step. */
function step(w: Work, starts: boolean): void {
  const { run } = w.cursor
  if (run === undefined || run.stepOpen === starts) return
  if (starts) run.step += 1
  run.stepOpen = starts
  w.out.push({ type: starts ? EventType.STEP_STARTED : EventType.STEP_FINISHED, stepName: `turn ${run.step}` })
}

/** The model call's state: a retry's backoff, a deferred response's poll. */
function generation(w: Work, event: PiEvent<'auto_retry_start' | 'auto_retry_end' | 'deferred_poll'>): void {
  if (event.type === 'auto_retry_start')
    return setState(w, 'generation', { attempt: event.attempt, retry: { at: event.at, error: event.errorMessage } })
  if (event.type === 'auto_retry_end') return setState(w, 'generation', { attempt: event.attempt + 1 })
  setState(w, 'generation', { attempt: w.cursor.state.generation?.attempt ?? 1, deferred: { pollAt: event.pollAt } })
}

/** The answer in flight begins (its first partial) or changes. */
function messageChanged(w: Work, event: PiEvent<'message_start' | 'message_update'>): void {
  const { cursor } = w
  if (event.type === 'message_update') {
    if (cursor.message !== undefined) for (const change of event.changes) applyChange(cursor.message, w.out, change)
    return
  }
  const { message } = event
  if (message.role !== 'assistant') return
  if (cursor.message !== undefined && cursor.message.at !== message.timestamp) endMessage(cursor.message, w.out)
  if (cursor.message?.at !== message.timestamp) cursor.message = beginMessage(cursor.chat, message.timestamp)
  if (cursor.state.generation === null) setState(w, 'generation', { attempt: 1 })
  for (const [index, block] of message.content.entries()) syncBlock(cursor.message, w.out, index, block)
}

/** One Pi event; `settled` are the batch's submission records (an aborted input stops its run). */
function apply(w: Work, event: AgentEvent, settled: ReadonlyMap<number, SubmissionRecord>): void {
  switch (event.type) {
    case 'snapshot':
      return reconcileWith(w, event)
    case 'run_start':
      return runStarted(w, event.inputs)
    case 'run_end':
      return runEnded(w, settled)
    case 'turn_start':
    case 'turn_end':
      return step(w, event.type === 'turn_start')
    case 'message_start':
    case 'message_update':
      return messageChanged(w, event)
    case 'message_end':
    case 'entry_appended':
      return entryCommitted(w, event.entry)
    case 'tool_execution_start':
      return toolStarted(w, event)
    case 'tool_execution_update':
      return toolUpdated(w, event)
    case 'tool_execution_end':
      return toolEnded(w, event)
    case 'inbox_update':
      return setState(w, 'queue', queueView(event.items, w.hints.queued))
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'deferred_poll':
      return generation(w, event)
    case 'agent_changed':
      return setState(w, 'agent', agentView(event.agent))
    case 'usage_changed':
      return setState(w, 'usage', usageView(event.usage))
    case 'compaction_start':
    case 'compaction_end':
      return compaction(w, event)
    case 'task_failed':
      if (w.cursor.run !== undefined && event.kind === 'pi.generation') w.cursor.run.failed = true
      return
    case 'submission':
      return
  }
}

/** The batch's submission records by id, and the operation ids of the inputs among them, kept for their run. */
function noteSubmissions(w: Work, events: readonly AgentEvent[]): ReadonlyMap<number, SubmissionRecord> {
  const records = new Map<number, SubmissionRecord>()
  const { operations } = w.cursor
  for (const event of events) {
    if (event.type !== 'submission') continue
    const { record } = event
    records.set(Number(record.id), record)
    const waiting = record.status === 'queued' || record.status === 'placed'
    if (record.type === 'input' && record.requestId !== undefined && waiting) operations[record.id] = record.requestId
  }
  const ids = Object.keys(operations).map(Number)
  for (const old of ids.toSorted((a, b) => a - b).slice(0, Math.max(0, ids.length - OPERATIONS_KEPT)))
    delete operations[old]
  return records
}

/** The entries the batch's starting run placed its inputs as: they are that run's, so they follow RUN_STARTED. */
function startingInputs(events: readonly AgentEvent[]): { readonly start?: AgentEvent; readonly entries: Set<number> } {
  const start = events.find((event) => event.type === 'run_start')
  if (start?.type !== 'run_start') return { entries: new Set() }
  const inputs = new Set(start.inputs.map(Number))
  const entries = new Set<number>()
  for (const event of events)
    if (event.type === 'submission' && inputs.has(Number(event.record.id)) && event.record.entry !== undefined)
      entries.add(Number(event.record.entry))
  return { start, entries }
}

/**
 * One committed batch of Pi's events (`watchEvents`) as AG-UI events. Pi announces a run after the entries of the
 * commit that started it; the run's own inputs are moved after its RUN_STARTED, so a run's events are its own. An
 * overflow's snapshot in the batch is reconciled.
 */
export function translate(cursor: StreamCursor, events: readonly AgentEvent[], hints: Hints = {}): Translation {
  const w = work(cursor, hints)
  const settled = noteSubmissions(w, events)
  const { start, entries } = startingInputs(events)
  const held: EntryRecord[] = []
  let started = start === undefined
  for (const event of events) {
    const input =
      (event.type === 'message_end' || event.type === 'entry_appended') && entries.has(Number(event.entry.id))
    if (input && !started) held.push(event.entry)
    else apply(w, event, settled)
    if (event !== start) continue
    started = true
    for (const entry of held.splice(0)) entryCommitted(w, entry)
  }
  for (const entry of held) entryCommitted(w, entry)
  return { events: w.out, cursor: w.cursor }
}

/** The index of the newest owner input among `entries`, where a run that started in them begins; -1 for none. */
const runBoundary = (entries: readonly EntryRecord[]): number => entries.findLastIndex(({ kind }) => kind === 'pi.user')

/**
 * The entries past the cursor, with a run that ended or began meanwhile: a new run begins at its newest owner input
 * among them (or after them all when none is), and the old one ends just before.
 */
function catchUpEntries(w: Work, entries: readonly EntryRecord[], inputs: readonly number[] | undefined): void {
  const { cursor } = w
  const runId = inputs === undefined ? undefined : runIdOf(cursor.chat, inputs)
  if (cursor.run?.id === runId) {
    for (const entry of entries) entryCommitted(w, entry)
    return
  }
  const boundary = inputs === undefined ? entries.length : Math.max(0, runBoundary(entries))
  for (const entry of entries.slice(0, boundary)) entryCommitted(w, entry)
  runEnded(w, new Map())
  if (inputs !== undefined) runStarted(w, inputs)
  for (const entry of entries.slice(boundary)) entryCommitted(w, entry)
}

/** The answer in flight as the snapshot has it: one the stream followed goes on, one that vanished ends. */
function catchUpMessage(w: Work, partial: AssistantMessage | undefined): void {
  const { cursor } = w
  if (cursor.message !== undefined && cursor.message.at !== partial?.timestamp) {
    endMessage(cursor.message, w.out)
    cursor.message = undefined
  }
  if (partial === undefined) return
  cursor.message ??= beginMessage(cursor.chat, partial.timestamp)
  for (const [index, block] of partial.content.entries()) syncBlock(cursor.message, w.out, index, block)
}

/**
 * Catch up from `snapshot`: the entries past the cursor and the runs among them, the rest of the answer in flight, and
 * every STATE member that changed. Nothing the stream carried is sent again.
 */
function reconcileWith(w: Work, snapshot: SnapshotEvent): void {
  const { cursor } = w
  hintedOperations(w)
  const entries = snapshot.entries.filter(({ id }) => Number(id) > cursor.lastEntryId)
  catchUpEntries(w, entries, snapshot.run?.inputs.map(Number))
  catchUpMessage(w, snapshot.generation?.message)
  const fresh = stateOf(snapshot, cursor.state.attention, w.hints.queued)
  for (const key of ['queue', 'generation', 'compactions', 'agent', 'usage'] as const) setState(w, key, fresh[key])
}

/** Catch up from a snapshot of the chat: after a watch overflowed, or when the producer watches the chat again. */
export function reconcile(cursor: StreamCursor, snapshot: SnapshotEvent, hints: Hints = {}): Translation {
  const w = work(cursor, hints)
  reconcileWith(w, snapshot)
  return { events: w.out, cursor: w.cursor }
}

/**
 * A connection's first events from `snapshot`: `MESSAGES_SNAPSHOT` with the messages of the newest `window` entries
 * (older history is read in pages), `STATE_SNAPSHOT`, then the run in flight (RUN_STARTED, and its answer so far).
 */
export function open(
  chat: string,
  snapshot: SnapshotEvent,
  options: { readonly window: number; readonly hints?: Hints },
): Translation {
  const w = work(startCursor(chat), options.hints ?? {})
  const omitted = new Set(snapshot.entries.flatMap(omittedBy))
  const visible = snapshot.entries.filter(({ id }) => !omitted.has(Number(id)))
  const attention = openAttention(chat, snapshot.entries)
  const windowed = visible.slice(-Math.max(1, options.window))
  const messages = windowed.flatMap((entry) => entryMessages(chat, entry))
  const state = stateOf(snapshot, [...attention], w.hints.queued)
  // Older history is read in pages before the window: one it cut, or what a head marker leaves out of the snapshot.
  const [first] = windowed
  const older = windowed.length < visible.length || snapshot.entries[0]?.head !== undefined
  const before = first !== undefined && older ? { before: Number(first.id) } : {}
  w.out.push(
    { type: EventType.MESSAGES_SNAPSHOT, messages, ...goblin(before) },
    { type: EventType.STATE_SNAPSHOT, snapshot: state },
  )
  w.cursor.state = state
  w.cursor.lastEntryId = Math.max(0, ...snapshot.entries.map(({ id }) => Number(id)))
  hintedOperations(w)
  if (snapshot.run !== undefined) runStarted(w, snapshot.run.inputs.map(Number))
  const partial = snapshot.generation?.message
  if (partial !== undefined) {
    w.cursor.message = beginMessage(chat, partial.timestamp)
    for (const [index, block] of partial.content.entries()) syncBlock(w.cursor.message, w.out, index, block)
  }
  return { events: w.out, cursor: w.cursor }
}
