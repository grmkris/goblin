import type { AgentEvent, SubmissionRecord } from '@earendil-works/pi-durable'
import {
  type AguiEvent,
  type AguiInterrupt,
  EventType,
  type GoblinMetadata,
  GoblinMetadataOf,
  type GoblinState,
  type PersonaInvocationView,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Hints, type StreamCursor, type Translation, translate } from './agui.ts'
import { entryMessageId, firstLine, goblin, reasoningId, reasoningSpanId, runIdOf } from './messages.ts'

// One send's run as AG-UI events (ADR 0111, docs/architecture/streams.md "Driving a chat"): a pure follower of the
// chat's translated events, no services and no I/O. It forwards nothing until the run that took the send's input
// starts (or it finds the input already in the run in flight), then that run's own events under the send's `runId` and
// `threadId` until its end. A chat's children (Personas' forks, subagents) are left out, so AG-UI's verifier never
// sees a subagent still at work when the run ends, and so is the send's own user message, which the client already
// holds. An ask of Personas has no run of the chat's: its run is made of the ask's answers, and ends when its
// invocations settle.

/** The send a run stream answers for: its chat, its run id (the operation id), and whether it asks Personas. */
export type RunTarget = {
  readonly chat: string
  readonly runId: string
  readonly ask: boolean
}

type Phase = 'waiting' | 'following' | 'done'

/** Whether `event` is one of a text message's. */
const texts = (
  event: AguiEvent,
): event is Extract<
  AguiEvent,
  { type: EventType.TEXT_MESSAGE_START | EventType.TEXT_MESSAGE_CONTENT | EventType.TEXT_MESSAGE_END }
> =>
  event.type === EventType.TEXT_MESSAGE_START ||
  event.type === EventType.TEXT_MESSAGE_CONTENT ||
  event.type === EventType.TEXT_MESSAGE_END

/** Whether `event` is a child's work or lifecycle, which a send's run leaves out. */
const childs = (event: AguiEvent): boolean =>
  event.type === EventType.SUBAGENT_STARTED ||
  event.type === EventType.SUBAGENT_FINISHED ||
  event.type === EventType.SUBAGENT_ERROR ||
  ('subagentRunId' in event && event.subagentRunId !== undefined)

const decodeMarks = Schema.decodeUnknownOption(GoblinMetadataOf)

/** goblin's own part of an event's metadata, as the translator wrote it. */
const goblinOf = (event: AguiEvent): GoblinMetadata | undefined =>
  event.metadata === undefined
    ? undefined
    : Option.getOrUndefined(Option.map(decodeMarks(event.metadata), (m) => m.goblin))

/** The operation a Persona's answer answers, when `event` starts one. */
const answering = (event: AguiEvent): string | undefined =>
  event.type === EventType.TEXT_MESSAGE_START && event.role === 'assistant'
    ? goblinOf(event)?.persona?.operationId
    : undefined

/**
 * The starts of what is open in the run in flight, from `cursor`: its step, the answer streaming, its open thinking
 * and its tool calls. A send that joined a run under way reads on from them; what they said so far is not repeated.
 */
function inFlight(cursor: StreamCursor): AguiEvent[] {
  const { run, message } = cursor
  const out: AguiEvent[] = []
  if (run?.stepOpen === true) out.push({ type: EventType.STEP_STARTED, stepName: `turn ${run.step}` })
  if (message === undefined) return out
  if (message.opened)
    out.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: message.id,
      role: 'assistant',
      ...goblin({ at: message.at }),
    })
  for (const block of message.blocks)
    if (block?.kind === 'toolCall')
      out.push({
        type: EventType.TOOL_CALL_START,
        toolCallId: block.id,
        toolCallName: block.name,
        parentMessageId: message.id,
      })
  const thinking = message.thinking === undefined ? undefined : message.blocks[message.thinking]
  if (message.thinking !== undefined && thinking?.kind === 'thinking' && thinking.hidden !== true)
    out.push(
      { type: EventType.REASONING_START, messageId: reasoningSpanId(message.id, message.thinking) },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningId(message.id, message.thinking),
        role: 'reasoning',
      },
    )
  return out
}

/** The questions among `interrupts`: the only ones a send answers in words (the rest have their own endpoints). */
const questions = (interrupts: readonly AguiInterrupt[]): AguiInterrupt[] =>
  interrupts.filter(({ reason }) => reason === 'question')

/** A run's end that is no error: done, stopped, or waiting on these questions. */
type Ending = 'success' | 'cancelled' | AguiInterrupt[]

/** A run's end in error: its code and a line to show. */
type Failure = { readonly code: string; readonly message: string }

/** How an input that ended ended, as its record says: answered, stopped, or failed with Pi's reason. */
function recordedEnd(record: SubmissionRecord): Ending | Failure {
  if (record.status !== 'unanswered') return 'success'
  if (record.reason === 'aborted') return 'cancelled'
  const detail = typeof record.detail === 'string' ? firstLine(record.detail) : ''
  return { code: record.reason, message: detail === '' ? record.reason : detail }
}

/** Whether an end is an error's. */
const failed = (end: Ending | Failure): end is Failure => typeof end === 'object' && !Array.isArray(end)

/** How the chat's run ended, as the send's run ends: waiting only on its questions. */
function endingOf(outcome: Extract<AguiEvent, { type: EventType.RUN_FINISHED }>['outcome']): Ending {
  if (outcome?.type === 'interrupt') return questions(outcome.interrupts)
  return outcome?.type === 'cancelled' ? 'cancelled' : 'success'
}

/**
 * One send's run, followed over the chat's events. `admitted` says where the send's input is once it was admitted,
 * `batch` takes each of Pi's batches, `invocations` the ask's invocations as they are now, `ended` the end of the
 * watch or of the stream's life; each answers the events to send. `done` once its end was sent.
 */
export class RunFollow {
  readonly #target: RunTarget
  #cursor: StreamCursor
  #phase: Phase = 'waiting'
  /** The opening's events after its RUN_STARTED: the run in flight when the watch began, as far as it got. */
  readonly #opening: readonly AguiEvent[]
  /** The send's input (a submission of Pi's) and its entry, once known. */
  #input: number | undefined
  #entry: number | undefined
  /** The chat's run that took the input. */
  #run: string | undefined
  /** The operation had ended or was under way before this send: a retry of it. */
  #replay = false
  /** The ask's answers being carried, by message id. */
  readonly #answers = new Set<string>()

  constructor(target: RunTarget, opening: Translation) {
    this.#target = target
    this.#cursor = opening.cursor
    const start = opening.events.findIndex(({ type }) => type === EventType.RUN_STARTED)
    this.#opening = start < 0 ? [] : opening.events.slice(start + 1)
  }

  get done(): boolean {
    return this.#phase === 'done'
  }

  /** The send's RUN_STARTED, under its own ids, naming the chat's run it follows. */
  #started(operations?: readonly string[]): AguiEvent {
    const { chat, runId } = this.#target
    const marks = {
      ...(this.#run === undefined ? {} : { run: this.#run }),
      ...(operations === undefined || operations.length === 0 ? {} : { operations }),
    }
    return { type: EventType.RUN_STARTED, threadId: chat, runId, ...goblin(marks) }
  }

  /** What a replay's end names: the input's entry and its answers'. */
  #replayed(entry: number | undefined, answers: readonly number[]): Pick<GoblinMetadata, 'replayed'> {
    if (!this.#replay) return {}
    return {
      replayed: { ...(entry === undefined ? {} : { entry }), ...(answers.length === 0 ? {} : { answers }) },
    }
  }

  /** The run ends with `events`: nothing more is sent. */
  #end(...events: AguiEvent[]): AguiEvent[] {
    this.#phase = 'done'
    return events
  }

  /** The send's run's end: RUN_FINISHED under its ids, or RUN_ERROR. */
  #finished(end: Ending | Failure, marks: GoblinMetadata = {}): AguiEvent {
    if (failed(end)) return { type: EventType.RUN_ERROR, ...end, ...goblin(marks) }
    const { chat, runId } = this.#target
    const outcome =
      end === 'success' || end === 'cancelled'
        ? { type: end }
        : end.length === 0
          ? { type: 'success' as const }
          : { type: 'interrupt' as const, interrupts: end }
    return { type: EventType.RUN_FINISHED, threadId: chat, runId, outcome, ...goblin(marks) }
  }

  /** The send's run opens: its RUN_STARTED, then STATE as `state`, and it follows the chat's run from there. */
  #opened(state: GoblinState, operations?: readonly string[]): AguiEvent[] {
    this.#phase = 'following'
    return [this.#started(operations), { type: EventType.STATE_SNAPSHOT, snapshot: state }]
  }

  /**
   * The send was admitted: `prior` is its operation's record from before (a retry when there was one), `record` the
   * one Pi keeps now. A finished retry answers at once, an input already in the run in flight starts from it, and a
   * send no run of the chat takes (it answered a routine's question, or went to a subagent through its spawner) ends at
   * once. Otherwise the run is waited for.
   */
  admitted(prior: SubmissionRecord | undefined, record: SubmissionRecord | undefined): AguiEvent[] {
    this.#replay = prior !== undefined
    if (this.#target.ask) return this.#opened(this.#cursor.state, [this.#target.runId])
    if (record?.type !== 'input') return this.#end(this.#started(), this.#finished('success'))
    this.#input = Number(record.id)
    this.#entry = record.entry === undefined ? undefined : Number(record.entry)
    if (this.#replay && (record.status === 'done' || record.status === 'unanswered')) {
      const answers = record.status === 'done' ? [Number(record.answer)] : []
      return this.#end(this.#started(), this.#finished(recordedEnd(record), this.#replayed(this.#entry, answers)))
    }
    const { run } = this.#cursor
    if (run === undefined || !run.inputs.includes(this.#input)) return []
    this.#run = run.id
    return [...this.#opened(this.#cursor.state), ...this.#own(this.#opening)]
  }

  /** The send's input, as this batch of Pi's records it, when it does. */
  #noted(events: readonly AgentEvent[]): SubmissionRecord | undefined {
    let found: SubmissionRecord | undefined
    for (const event of events)
      if (event.type === 'submission' && Number(event.record.id) === this.#input) found = event.record
    if (found?.entry !== undefined) this.#entry = Number(found.entry)
    return found
  }

  /** One batch of Pi's: translated over the chat's cursor, then what of it is the send's run. */
  batch(events: readonly AgentEvent[], hints: Hints = {}): AguiEvent[] {
    if (this.#phase === 'done') return []
    const record = this.#noted(events)
    const before = this.#cursor.state
    const translated = translate(this.#cursor, events, hints)
    this.#cursor = translated.cursor
    if (this.#target.ask) return this.#answered(translated.events)
    if (this.#phase === 'following') return this.#own(translated.events)
    return this.#claim(translated.events, before, record)
  }

  /** Whether `event` starts the chat's run that took the send's input. */
  #takes(event: Extract<AguiEvent, { type: EventType.RUN_STARTED }>): boolean {
    if (this.#input !== undefined && event.runId === runIdOf(this.#target.chat, [this.#input])) return true
    return goblinOf(event)?.operations?.includes(this.#target.runId) === true
  }

  /**
   * The run that took the input, if it starts in `events`: from its RUN_STARTED on, the send's run, opening with STATE
   * as it was before the batch and the batch's changes of it before the run began. An input withdrawn before any run
   * took it ends the send's run in error; one placed into the run in flight joins it, from what is open in it now.
   */
  #claim(events: readonly AguiEvent[], before: GoblinState, record: SubmissionRecord | undefined): AguiEvent[] {
    for (const [index, event] of events.entries()) {
      if (event.type !== EventType.RUN_STARTED || !this.#takes(event)) continue
      this.#run = event.runId
      const changed = events.slice(0, index).filter(({ type }) => type === EventType.STATE_DELTA)
      const opened = this.#opened(before, goblinOf(event)?.operations)
      return [...opened, ...changed, ...this.#own(events.slice(index + 1))]
    }
    if (record?.status === 'unanswered') {
      const ended = recordedEnd(record)
      return this.#end(
        this.#started(),
        this.#finished(failed(ended) ? ended : { code: 'withdrawn', message: 'withdrawn' }),
      )
    }
    const { run } = this.#cursor
    if (record?.status === 'placed' && run !== undefined) {
      this.#run = run.id
      return [...this.#opened(this.#cursor.state), ...inFlight(this.#cursor)]
    }
    if (record?.status === 'done') return this.#end(this.#started(), this.#finished('success'))
    return []
  }

  /**
   * Whether the send's run leaves `event` out: a child's, the send's own user message (which its client already
   * holds), and what opens a connection or a run, which the chat's run never sends once under way.
   */
  #skips(event: AguiEvent): boolean {
    if (childs(event) || event.type === EventType.RUN_STARTED || event.type === EventType.MESSAGES_SNAPSHOT) return true
    return (
      this.#entry !== undefined && texts(event) && event.messageId === entryMessageId(this.#target.chat, this.#entry)
    )
  }

  /** The run's own events among `events`, until its end, its RUN_FINISHED under the send's ids. */
  #own(events: readonly AguiEvent[]): AguiEvent[] {
    const out: AguiEvent[] = []
    for (const event of events) {
      if (this.#skips(event)) continue
      if (event.type === EventType.RUN_ERROR) return [...out, ...this.#end(event)]
      if (event.type !== EventType.RUN_FINISHED) {
        out.push(event)
        continue
      }
      const usage = event.usage === undefined ? {} : { usage: event.usage }
      return [...out, ...this.#end({ ...this.#finished(endingOf(event.outcome)), ...usage })]
    }
    return out
  }

  /** An ask's answers among `events`: each Persona's answer to the send, as the chat stream writes it, and STATE. */
  #answered(events: readonly AguiEvent[]): AguiEvent[] {
    if (this.#phase !== 'following') return []
    const out: AguiEvent[] = []
    for (const event of events) {
      if (event.type === EventType.TEXT_MESSAGE_START && answering(event) === this.#target.runId)
        this.#answers.add(event.messageId)
      if ((texts(event) && this.#answers.has(event.messageId)) || event.type === EventType.STATE_DELTA) out.push(event)
    }
    return out
  }

  /**
   * The ask's invocations as they are now: once every one settled and each answer is carried, the ask's run ends. It
   * failed when no Persona answered and one failed, was cancelled when every one was stopped, and otherwise waits on
   * the owner when an answer asked questions.
   */
  invocations(views: readonly PersonaInvocationView[]): AguiEvent[] {
    if (!this.#target.ask || this.#phase !== 'following' || views.length === 0) return []
    if (views.some(({ state }) => state === 'pending' || state === 'running')) return []
    const answered = views.flatMap(({ state, answerEntry }) =>
      state === 'answered' && answerEntry !== undefined ? [answerEntry] : [],
    )
    if (answered.some((entry) => entry > this.#cursor.lastEntryId)) return []
    const marks = this.#replayed(undefined, answered)
    if (answered.length > 0) {
      const asked = this.#cursor.state.attention.filter(({ metadata }) => answered.includes(metadata.goblin.entryId))
      return this.#end(this.#finished(questions(asked), marks))
    }
    const fault = views.find(({ state }) => state === 'failed')
    const end = fault === undefined ? 'cancelled' : { code: fault.reason ?? 'failed', message: 'No Persona answered.' }
    return this.#end(this.#finished(end, marks))
  }

  /**
   * The send's run ends before its own end came: the chat's events stopped (`stream_ended`), or the stream reached
   * its life (`stream_lifetime`). The run goes on in the chat; its stream and entries tell the rest.
   */
  ended(code: 'stream_ended' | 'stream_lifetime'): AguiEvent[] {
    if (this.#phase === 'done') return []
    const error = this.#finished({ code, message: 'Read the rest from the chat.' })
    return this.#phase === 'waiting' ? this.#end(this.#started(), error) : this.#end(error)
  }
}
