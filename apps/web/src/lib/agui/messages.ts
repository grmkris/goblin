// A chat's AG-UI messages (docs/architecture/streams.md) as the transcript's messages (`ChatMessage`): the snapshot an
// epoch opens with, what streamed since, and the older pages the history endpoint answers, all mapped here alike. The
// transcript keeps its ids, `<entry>:<index>`, from `metadata.goblin.entryId`, so a message keeps one id wherever it
// was read. goblin's marks are decoded by their contract; anything a newer server adds is read past.
import {
  ActivityType,
  DelegateResultData,
  type GoblinMetadata,
  GoblinMetadataOf,
  NoticeData,
  type StopMark,
  ThreadHeadData,
  ThreadStartedData,
  TopicSeedData,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type ChatMessage, type ToolCallView, type TurnFailure, failureReason } from '../chat-messages.ts'
import { identifier, isNumber, isString, record, records, text } from '../values.ts'

/** A message or event as the stream carries it: JSON, read field by field. */
export type Wire = Record<string, unknown>

const decodeMarks = Schema.decodeUnknownOption(GoblinMetadataOf)
const marksSeen = new WeakMap<Wire, GoblinMetadata>()

/** goblin's marks of a message or an event (`metadata.goblin`); none when it carries none this tab can read. */
export function marksOf(wire: Wire): GoblinMetadata {
  const known = marksSeen.get(wire)
  if (known !== undefined) return known
  const marks =
    wire.metadata === undefined
      ? {}
      : Option.match(decodeMarks(wire.metadata), { onNone: () => ({}), onSome: ({ goblin }) => goblin })
  marksSeen.set(wire, marks)
  return marks
}

/** The transcript's id of a message of `entry`: its place among the entry's model messages follows the entry. */
const transcriptId = (id: string, entry: number): string => `${entry}:${/:e\d+:(\d+)$/u.exec(id)?.[1] ?? '0'}`

/** The assistant message a reasoning message belongs to, by the stream's id (`<assistant>:r<block>`). */
export const reasoningOwner = (id: string): string | undefined => /^(.*):r\d+$/u.exec(id)?.[1]

/** Why a turn has no whole answer: the model call failed, was stopped, or was cut off at the output limit. */
function failureOf(stop: StopMark | undefined): TurnFailure | undefined {
  if (stop === undefined) return undefined
  if (stop.reason === 'aborted') return { text: 'Stopped before answering.', provider: false, stopped: true }
  if (stop.reason === 'length')
    return { text: 'Cut off at the output limit. Ask it to continue.', provider: false, cutOff: true }
  return failureReason(stop.message ?? '')
}

/** A tool call's arguments, from the JSON text AG-UI carries them as. */
function argumentsOf(json: unknown): Record<string, unknown> {
  if (!isString(json)) return {}
  try {
    return record(JSON.parse(json)) ?? {}
  } catch {
    // expected: arguments still arriving or not JSON show as none until they are whole
    return {}
  }
}

/** The tool calls an assistant message asked for. */
const toolCallsOf = (wire: Wire): ToolCallView[] =>
  records(wire.toolCalls).map((call) => {
    const fn = record(call.function)
    return { id: identifier(call.id), name: identifier(fn?.name), arguments: argumentsOf(fn?.arguments) }
  })

/** What each message's mapping reads beside the message itself: each assistant message's thinking. */
type Around = { readonly reasoning: ReadonlyMap<string, string> }

const at = (marks: GoblinMetadata) => (marks.at === undefined ? {} : { timestamp: marks.at })

function userMessage(wire: Wire, id: string, marks: GoblinMetadata): ChatMessage {
  const { context, attachments, selections, author, outcome, own, member, kept, thread, ask } = marks
  return {
    id,
    role: 'user',
    text: text(wire.content),
    ...(context !== undefined && context.length > 0 && { context }),
    ...(attachments !== undefined && attachments.length > 0 && { attachments }),
    ...(selections !== undefined && selections.length > 0 && { selections }),
    ...(author !== undefined && { author }),
    ...(outcome !== undefined && { outcome }),
    ...(own === true && { own }),
    ...(member !== undefined && { member }),
    ...(kept === true && { kept }),
    ...(thread !== undefined && { thread }),
    ...(ask !== undefined && { ask }),
    ...at(marks),
  }
}

function assistantMessage(wire: Wire, id: string, marks: GoblinMetadata, around: Around): ChatMessage {
  const words = text(wire.content)
  if (marks.persona !== undefined) {
    const { id: persona, ...answer } = marks.persona
    return { id, role: 'persona', answer: { persona, ...answer, text: words }, ...at(marks) }
  }
  const reasoning = around.reasoning.get(identifier(wire.id))
  const failure = failureOf(marks.stop)
  const { usage } = marks
  return {
    id,
    role: 'assistant',
    text: words,
    toolCalls: toolCallsOf(wire),
    ...(reasoning !== undefined && reasoning !== '' && { reasoning }),
    ...(usage !== undefined && {
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
      },
    }),
    ...at(marks),
    ...(failure !== undefined && { failure }),
  }
}

function toolMessage(wire: Wire, id: string, marks: GoblinMetadata): ChatMessage {
  const toolCallId = identifier(wire.toolCallId)
  return {
    id,
    role: 'tool',
    text: text(wire.content),
    toolCallId,
    toolName: marks.toolName ?? '',
    isError: marks.isError === true,
    details: marks.details,
    ...at(marks),
  }
}

const decodeHead = Schema.decodeUnknownOption(ThreadHeadData)
const decodeStarted = Schema.decodeUnknownOption(ThreadStartedData)
const decodeNotice = Schema.decodeUnknownOption(NoticeData)
const decodeSeed = Schema.decodeUnknownOption(TopicSeedData)
const decodeResult = Schema.decodeUnknownOption(DelegateResultData)

/** The one message decoded data makes, or none when it did not decode. */
const one = <A>(decoded: Option.Option<A>, message: (data: A) => ChatMessage): ChatMessage[] =>
  Option.match(decoded, { onNone: () => [], onSome: (data) => [message(data)] })

/** An entry the app draws itself, by its activity type and contract; none for a type or content this tab cannot read. */
function activityMessage(wire: Wire, id: string, marks: GoblinMetadata): ChatMessage[] {
  const content = wire.content
  const when = at(marks)
  switch (wire.activityType) {
    case ActivityType.threadHead:
      return one(decodeHead(content), (head) => ({ id, role: 'thread-head', head, ...when }))
    case ActivityType.threadStarted:
      return one(decodeStarted(content), ({ thread }) => ({ id, role: 'thread-started', thread, ...when }))
    case ActivityType.notice:
      return one(decodeNotice(content), (notice) => ({ id, role: 'notice', notice, ...when }))
    case ActivityType.topicSeed:
      return one(decodeSeed(content), (seed) => ({ id, role: 'topic-seed', seed, ...when }))
    case ActivityType.delegateResult:
      return one(decodeResult(content), (result) => ({ id, role: 'delegate-result', result, ...when }))
    default:
      return []
  }
}

/** The transcript's messages of one AG-UI message; reasoning goes with its assistant message, and none has an entry. */
function mapped(wire: Wire, around: Around): ChatMessage[] {
  const marks = marksOf(wire)
  if (marks.entryId === undefined) return []
  const id = transcriptId(identifier(wire.id), marks.entryId)
  switch (wire.role) {
    case 'user':
      return [userMessage(wire, id, marks)]
    case 'assistant':
      return [assistantMessage(wire, id, marks, around)]
    case 'tool':
      return [toolMessage(wire, id, marks)]
    case 'activity':
      return activityMessage(wire, id, marks)
    default:
      return []
  }
}

const seen = new WeakMap<Wire, { readonly reasoning: string | undefined; readonly messages: ChatMessage[] }>()

/**
 * `messagesOf` once per message: a committed message never changes, so the transcript's messages keep their identity
 * from one batch to the next and only rows that changed render again. An assistant message is mapped again only when
 * its thinking differs.
 */
function messagesOf(wire: Wire, around: Around): ChatMessage[] {
  const reasoning = around.reasoning.get(identifier(wire.id))
  const known = seen.get(wire)
  if (known !== undefined && known.reasoning === reasoning) return known.messages
  const messages = mapped(wire, around)
  seen.set(wire, { reasoning, messages })
  return messages
}

/** Each assistant message's visible thinking, joined as one: its reasoning messages, each trimmed, empty ones left out. */
function reasoningByMessage(messages: readonly Wire[]): Map<string, string> {
  const thoughts = new Map<string, string[]>()
  for (const message of messages) {
    if (message.role !== 'reasoning') continue
    const owner = reasoningOwner(identifier(message.id))
    const thought = text(message.content).trim()
    if (owner !== undefined && thought !== '') thoughts.set(owner, [...(thoughts.get(owner) ?? []), thought])
  }
  return new Map([...thoughts].map(([owner, each]) => [owner, each.join('\n\n')]))
}

/** The entries `messages` speak for: those a Thread may start at, those they leave out, the oldest and the newest. */
export function entriesOf(messages: readonly Wire[]) {
  const branchable = new Set<number>()
  const omitted = new Set<number>()
  let oldest: number | undefined
  let newest = 0
  for (const message of messages) {
    const { entryId, branchable: branch, omits } = marksOf(message)
    for (const target of omits ?? []) omitted.add(target)
    if (entryId === undefined) continue
    if (branch === true) branchable.add(entryId)
    oldest = Math.min(oldest ?? entryId, entryId)
    newest = Math.max(newest, entryId)
  }
  return { branchable, omitted, oldest, newest }
}

/**
 * `messages` as the transcript's, in order, without the entries `omitted` names: an assistant message carries its
 * thinking.
 */
export function chatMessages(messages: readonly Wire[], omitted: ReadonlySet<number>): ChatMessage[] {
  const around = { reasoning: reasoningByMessage(messages) }
  return messages.flatMap((message) => {
    const entry = marksOf(message).entryId
    return isNumber(entry) && omitted.has(entry) ? [] : messagesOf(message, around)
  })
}
