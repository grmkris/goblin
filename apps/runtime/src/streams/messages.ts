import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  ActivityType,
  type AguiEvent,
  type AguiMessage,
  DelegateResultData,
  EventType,
  type GoblinMetadata,
  NoticeData,
  PersonaAnswerData,
  PersonaAskData,
  type StopMark,
  ThreadHeadData,
  ThreadStartedData,
  TopicSeedData,
} from '@goblin/contracts'
import { Predicate } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { tokenCounts } from './state.ts'
import { userParts } from './user.ts'

// Committed Pi entries as AG-UI messages (a `MESSAGES_SNAPSHOT`'s), and a message as the events that write it, for an
// entry the stream did not see streaming. The ids are the stream's public contract (docs/architecture/streams.md).

/** The run that settles `inputs` in `chat`: its first input names it. Pi always names one; `0` stands in for none. */
export const runIdOf = (chat: string, inputs: readonly number[]): string => `${chat}:${inputs[0] ?? 0}`
/** An assistant message: Pi keeps its request's start time from the first partial to the committed entry. */
export const assistantId = (chat: string, at: number): string => `${chat}:a${at}`
/** A tool's result message, by the call it answers. */
export const toolResultId = (chat: string, toolCallId: string): string => `${chat}:t${toolCallId}`
/** Any other entry's message; the `index`th model message of an entry after its first adds `:<index>`. */
export const entryMessageId = (chat: string, entry: number, index = 0): string =>
  index === 0 ? `${chat}:e${entry}` : `${chat}:e${entry}:${index}`
/** A thinking block's reasoning message, and the reasoning span around it (AG-UI keeps the two apart). */
export const reasoningId = (message: string, index: number): string => `${message}:r${index}`
export const reasoningSpanId = (message: string, index: number): string => `${message}:s${index}`

/** `metadata` with goblin's fields, or none when there are none. */
export const goblin = (mark: GoblinMetadata): { readonly metadata?: { readonly goblin: GoblinMetadata } } =>
  Object.keys(mark).length === 0 ? {} : { metadata: { goblin: mark } }

/** Entries that start the model's context (memory view, compaction summary, reset): written for the model only. */
const MARKERS = new Set(['app.memory', 'pi.compaction', 'pi.reset'])

/** The entries whose data the app draws itself, by their activity type and contract. */
const ACTIVITIES: Readonly<Record<string, { readonly type: string; readonly data: Schema.Top }>> = {
  'app.thread_head': { type: ActivityType.threadHead, data: ThreadHeadData },
  'app.thread_started': { type: ActivityType.threadStarted, data: ThreadStartedData },
  'app.notice': { type: ActivityType.notice, data: NoticeData },
  'app.topic_seed': { type: ActivityType.topicSeed, data: TopicSeedData },
  'app.delegate_result': { type: ActivityType.delegateResult, data: DelegateResultData },
}

const decodePersona = Schema.decodeUnknownOption(PersonaAnswerData)
const decodeAsk = Schema.decodeUnknownOption(PersonaAskData)

/** The "[to @A, @B] " the model reads before the owner's words to Personas; `ask` says whom instead. */
const ASKED = /^\[to [^\]\n]*\]\s*/u

/** A text block's words, joined as the transcript joins them. */
export const textOf = (content: readonly { readonly type: string }[]): string =>
  content.flatMap((block) => ('text' in block && Predicate.isString(block.text) ? [block.text] : [])).join('\n')

/** The first line of an error, short enough to show; empty for none. */
export const firstLine = (text: string): string =>
  (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200)

/** Why an assistant message has no whole answer, with the provider's first line for a failure. */
export function stopOf(message: Pick<AssistantMessage, 'stopReason' | 'errorMessage'>): StopMark | undefined {
  if (message.stopReason === 'aborted' || message.stopReason === 'length') return { reason: message.stopReason }
  if (message.stopReason !== 'error') return undefined
  const line = firstLine(message.errorMessage ?? '')
  return line === '' ? { reason: 'error' } : { reason: 'error', message: line }
}

/** An assistant message as the snapshot carries it: its visible thinking, then the message with its tool calls. */
function assistantMessages(
  chat: string,
  entry: number,
  message: AssistantMessage,
  marks: GoblinMetadata,
): AguiMessage[] {
  const id = assistantId(chat, message.timestamp)
  const reasoning = message.content.flatMap((block, index): AguiMessage[] =>
    block.type === 'thinking' && block.redacted !== true && block.thinking !== ''
      ? [{ id: reasoningId(id, index), role: 'reasoning', content: block.thinking }]
      : [],
  )
  const toolCalls = message.content.flatMap((block) =>
    block.type === 'toolCall'
      ? [
          {
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.arguments) },
          },
        ]
      : [],
  )
  const text = textOf(message.content)
  const stop = stopOf(message)
  const mark = {
    entryId: entry,
    at: message.timestamp,
    ...(stop === undefined ? {} : { stop }),
    usage: tokenCounts(message.usage),
    ...marks,
  }
  return [
    ...reasoning,
    {
      id,
      role: 'assistant',
      ...(text === '' ? {} : { content: text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...goblin(mark),
    },
  ]
}

/** A tool's result: its text, and Pi's details for UIs; an error result says so. */
function toolMessage(chat: string, entry: number, message: ToolResultMessage, marks: GoblinMetadata): AguiMessage {
  const content = textOf(message.content)
  const details = message.details === undefined ? {} : { details: message.details }
  return {
    id: toolResultId(chat, message.toolCallId),
    role: 'tool',
    toolCallId: message.toolCallId,
    content,
    ...(message.isError ? { error: content === '' ? 'The tool failed.' : content } : {}),
    ...goblin({ entryId: entry, at: message.timestamp, ...details, isError: message.isError, ...marks }),
  }
}

/** What an entry's kind adds to its user message: a routine's report is the Routine's, a note names its thread. */
function kindMarks(entry: EntryRecord): GoblinMetadata {
  const data = Predicate.isReadonlyObject(entry.data) ? entry.data : {}
  const thread = 'thread' in data && Predicate.isString(data.thread) ? { thread: data.thread } : {}
  if (entry.kind === 'app.routine') return { author: 'Routine', ...thread }
  if (entry.kind === 'app.shared') return thread
  if (entry.kind === 'app.mcp_outcome') return { kept: true }
  if (entry.kind !== 'app.persona_ask') return {}
  return Option.match(decodeAsk(entry.data), { onNone: () => ({}), onSome: (ask) => ({ ask }) })
}

/** A user message: its words and marks, the kind's own marks over them. */
function userMessage(entry: EntryRecord, id: string, message: UserMessage, marks: GoblinMetadata): AguiMessage {
  const { text, mark } = userParts(message.content)
  const kind = kindMarks(entry)
  const words = kind.ask === undefined ? text : text.replace(ASKED, '')
  const all: GoblinMetadata = { entryId: Number(entry.id), at: message.timestamp, ...mark, ...kind, ...marks }
  const name = all.member?.name ?? all.author
  return { id, role: 'user', content: words, ...(name === undefined ? {} : { name }), ...goblin(all) }
}

/** The messages of one Pi model message in `entry`, the `index`th of the entry's, with the entry's own marks. */
function modelMessages(
  chat: string,
  entry: EntryRecord,
  [message, index]: readonly [Message, number],
  marks: GoblinMetadata,
): AguiMessage[] {
  const id = Number(entry.id)
  switch (message.role) {
    case 'assistant':
      return assistantMessages(chat, id, message, marks)
    case 'toolResult':
      return [toolMessage(chat, id, message, marks)]
    case 'user':
      return [userMessage(entry, entryMessageId(chat, id, index), message, marks)]
    case 'system':
      return []
  }
}

/** A Persona's attributed answer (`app.persona`, ADR 0033): an assistant message in its name. */
const personaMessage = (
  chat: string,
  entry: EntryRecord,
  answer: PersonaAnswerData,
  marks: GoblinMetadata,
): AguiMessage => {
  const { persona, name, revision, avatar, operationId, routine, hold, questions, text } = answer
  const mark = {
    id: persona,
    name,
    revision,
    avatar,
    operationId,
    ...(routine === undefined ? {} : { routine }),
    ...(hold === undefined ? {} : { hold }),
    ...(questions === undefined ? {} : { questions }),
  }
  const at = entry.model?.[0]?.timestamp
  return {
    id: entryMessageId(chat, Number(entry.id)),
    role: 'assistant',
    name,
    content: text,
    ...goblin({ entryId: Number(entry.id), ...(at === undefined ? {} : { at }), persona: mark, ...marks }),
  }
}

/** An entry the app draws itself, as its activity message; none when its data is not its contract's. */
function activityMessage(chat: string, entry: EntryRecord, marks: GoblinMetadata): AguiMessage[] | undefined {
  const activity = Object.hasOwn(ACTIVITIES, entry.kind) ? ACTIVITIES[entry.kind] : undefined
  if (activity === undefined) return undefined
  if (!Schema.is(activity.data)(entry.data) || !Predicate.isReadonlyObject(entry.data)) return []
  const at = entry.model?.[0]?.timestamp
  const mark = { entryId: Number(entry.id), ...(at === undefined ? {} : { at }), ...marks }
  return [
    {
      id: entryMessageId(chat, Number(entry.id)),
      role: 'activity',
      activityType: activity.type,
      content: { ...entry.data },
      ...goblin(mark),
    },
  ]
}

/** The held call whose outcome `entry` brings back (ADR 0042), when it brings one: it settles that call's items. */
export function outcomeOf(entry: EntryRecord): { readonly connectionId: string; readonly name: string } | undefined {
  for (const message of entry.model ?? []) {
    const continuation = message.role === 'user' ? userParts(message.content).mark.outcome?.continuation : undefined
    if (continuation !== undefined) return { connectionId: continuation.connectionId, name: continuation.name }
  }
  return undefined
}

/** The Persona answer an entry is, when it is one. */
export const personaAnswer = (entry: EntryRecord): PersonaAnswerData | undefined =>
  entry.kind === 'app.persona' ? Option.getOrUndefined(decodePersona(entry.data)) : undefined

/**
 * One committed entry as AG-UI messages, in transcript order: markers make none, a Persona's answer is an assistant
 * message in its name, the entries the app draws are activities, and every other entry's model messages are what
 * they are (the owner's and others' words, the agent's answers with their thinking and tool calls, tool results).
 */
export function entryMessages(chat: string, entry: EntryRecord): AguiMessage[] {
  if (MARKERS.has(entry.kind)) return []
  const marks = entryMarks(entry)
  const answer = personaAnswer(entry)
  if (answer !== undefined) return [personaMessage(chat, entry, answer, marks)]
  if (entry.kind === 'app.persona') return []
  return (
    activityMessage(chat, entry, marks) ??
    (entry.model ?? []).flatMap((message, index) => modelMessages(chat, entry, [message, index], marks))
  )
}

/** The entries a Thread may start at (ADR 0034): the owner's own words and the agent's answers. */
const BRANCHABLE = new Set(['pi.user', 'pi.assistant'])

/** The entries `entry`'s edits leave out of the chat (a turn moved to a Thread). */
export const omittedBy = (entry: Pick<EntryRecord, 'edits'>): number[] =>
  (entry.edits ?? []).flatMap(({ target, action }) => (action === 'omit' ? [Number(target)] : []))

/** What an entry's every message says of the entry itself: a Thread may start there, and what it leaves out. */
export function entryMarks(entry: EntryRecord): GoblinMetadata {
  const omits = omittedBy(entry)
  return {
    ...(BRANCHABLE.has(entry.kind) ? { branchable: true } : {}),
    ...(omits.length === 0 ? {} : { omits }),
  }
}

/**
 * The events that write `message` of entry `entryId` all at once: a message the stream never saw streaming. A text
 * message's marks go on its start, and its end names the entry, as a streamed answer's does.
 */
export function messageEvents(message: AguiMessage, entryId: number): AguiEvent[] {
  const meta = message.metadata === undefined ? {} : { metadata: message.metadata }
  switch (message.role) {
    case 'user':
    case 'assistant': {
      const text = typeof message.content === 'string' ? message.content : ''
      const start = { type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: message.role } as const
      const calls = message.role === 'assistant' ? (message.toolCalls ?? []) : []
      return [
        { ...start, ...(message.name === undefined ? {} : { name: message.name }), ...meta },
        ...(text === '' ? [] : [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: text } as const]),
        { type: EventType.TEXT_MESSAGE_END, messageId: message.id, ...goblin({ entryId }) },
        ...calls.flatMap((call): AguiEvent[] => [
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: call.id,
            toolCallName: call.function.name,
            parentMessageId: message.id,
          },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: call.function.arguments },
          { type: EventType.TOOL_CALL_END, toolCallId: call.id },
        ]),
      ]
    }
    case 'reasoning':
      return reasoningEvents(message.id, message.content)
    case 'tool':
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: message.id,
          toolCallId: message.toolCallId,
          content: message.content,
          role: 'tool',
          ...meta,
        },
      ]
    case 'activity':
      return [
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: message.id,
          activityType: message.activityType,
          content: message.content,
          ...meta,
        },
      ]
    case 'developer':
    case 'system':
      return []
  }
}

/** A whole reasoning message in its span; `id` is the message's (`<assistant>:r<i>`), the span's is `:s<i>`. */
function reasoningEvents(id: string, content: string): AguiEvent[] {
  const span = id.replace(/:r(\d+)$/u, ':s$1')
  return [
    { type: EventType.REASONING_START, messageId: span },
    { type: EventType.REASONING_MESSAGE_START, messageId: id, role: 'reasoning' },
    ...(content === '' ? [] : [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta: content } as const]),
    { type: EventType.REASONING_MESSAGE_END, messageId: id },
    { type: EventType.REASONING_END, messageId: span },
  ]
}
