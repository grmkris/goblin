import type { InspectEntries, InspectEntry, OtlpTraceData } from '@goblin/contracts/inspect'

type Span = OtlpTraceData['resourceSpans'][number]['scopeSpans'][number]['spans'][number]
type Attribute = Span['attributes'][number]

/** A page of a chat's entries ending before `before` (the newest without it); none when the chat cannot be read. */
export type ReadEntries = (chat: string, before?: number) => Promise<InspectEntries | undefined>

/** The most pages read back through one chat for one trace. */
const MAX_PAGES = 20

const stringAt = (span: Span, key: string): string | undefined => {
  const value = span.attributes.find((attribute) => attribute.key === key)?.value.stringValue
  return typeof value === 'string' ? value : undefined
}
const numberAt = (span: Span, key: string): number | undefined => {
  const value = span.attributes.find((attribute) => attribute.key === key)?.value.intValue
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isInteger(number) ? number : undefined
}
const json = (key: string, value: unknown): Attribute => ({ key, value: { stringValue: JSON.stringify(value) } })
const spansOf = (trace: OtlpTraceData) =>
  trace.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))

/** An answer as one GenAI output message: its thinking, words and tool calls as parts. */
function assistantMessage(entry: InspectEntry) {
  const calls = (entry.toolCalls ?? []).map((call) => ({
    type: 'tool_call',
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }))
  return {
    role: 'assistant',
    parts: [
      ...(entry.thinking === undefined ? [] : [{ type: 'reasoning', content: entry.thinking }]),
      ...(entry.text === undefined ? [] : [{ type: 'text', content: entry.text }]),
      ...calls,
    ],
  }
}

const textMessage = (role: string, entry: InspectEntry) => ({
  role,
  parts: entry.text === undefined ? [] : [{ type: 'text', content: entry.text }],
})

/** The entries a trace's spans name, by chat: their own (`goblin.entry`) and a turn's submission and answer. */
function wanted(trace: OtlpTraceData): Map<string, Set<number>> {
  const byChat = new Map<string, Set<number>>()
  for (const span of spansOf(trace)) {
    const chat = stringAt(span, 'goblin.chat')
    if (chat === undefined) continue
    const ids = byChat.get(chat) ?? new Set<number>()
    for (const key of ['goblin.entry', 'goblin.submission.entry', 'goblin.submission.answer']) {
      const id = numberAt(span, key)
      if (id !== undefined) ids.add(id)
    }
    byChat.set(chat, ids)
  }
  return byChat
}

/** A chat's entries back to the oldest of `ids`, newest page first, by id. */
async function entriesOf(chat: string, ids: ReadonlySet<number>, read: ReadEntries) {
  const oldest = Math.min(...ids)
  const entries = new Map<number, InspectEntry>()
  let before: number | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const found = await read(chat, before)
    if (found === undefined) break
    for (const entry of found.entries) entries.set(entry.id, entry)
    if (found.before === undefined || found.before <= oldest) break
    before = found.before
  }
  return entries
}

/** That an entry's words were cut, when they were. */
const truncatedMark = (entry: InspectEntry): Attribute[] =>
  entry.truncated === true ? [{ key: 'goblin.content.truncated', value: { boolValue: true } }] : []

const textAttribute = (key: string, value: string | undefined): Attribute[] =>
  value === undefined ? [] : [{ key, value: { stringValue: value } }]

/** A tool call's arguments, from the answer that made it, and its result, from its own entry. */
function toolContent(span: Span, result: InspectEntry, all: readonly InspectEntry[]): Attribute[] {
  const callId = stringAt(span, 'gen_ai.tool.call.id')
  const call = all.flatMap((each) => each.toolCalls ?? []).find((each) => each.id === callId)
  return [
    ...textAttribute('gen_ai.tool.call.arguments', call?.arguments),
    ...textAttribute('gen_ai.tool.call.result', result.text),
    ...truncatedMark(result),
  ]
}

/** A turn's input and output messages: what was submitted, and its answer. */
function turnContent(span: Span, entries: ReadonlyMap<number, InspectEntry>): Attribute[] {
  const asked = entries.get(numberAt(span, 'goblin.submission.entry') ?? -1)
  const answered = entries.get(numberAt(span, 'goblin.submission.answer') ?? -1)
  return [
    ...(asked === undefined ? [] : [json('gen_ai.input.messages', [textMessage('user', asked)])]),
    ...(answered === undefined ? [] : [json('gen_ai.output.messages', [assistantMessage(answered)])]),
  ]
}

/** What a span gains from the entries it names: the conventions' opt-in content attributes. */
function contentOf(span: Span, entries: ReadonlyMap<number, InspectEntry>): Attribute[] {
  if (span.name.startsWith('invoke_agent ')) return turnContent(span, entries)
  const entry = entries.get(numberAt(span, 'goblin.entry') ?? -1)
  if (entry === undefined) return []
  if (span.name.startsWith('chat '))
    return [json('gen_ai.output.messages', [assistantMessage(entry)]), ...truncatedMark(entry)]
  return span.name.startsWith('execute_tool ') ? toolContent(span, entry, [...entries.values()]) : []
}

/**
 * `trace` with the words of its turn (ADR 0107), read on this machine through `read` (`inspect_conversation`), in the
 * GenAI conventions' opt-in content attributes: a model call's output messages, a tool call's arguments and result,
 * and the turn's input and output messages. A span whose entries cannot be read keeps what it had.
 */
export async function withContent(trace: OtlpTraceData, read: ReadEntries): Promise<OtlpTraceData> {
  const byChat = new Map<string, ReadonlyMap<number, InspectEntry>>()
  for (const [chat, ids] of wanted(trace)) if (ids.size > 0) byChat.set(chat, await entriesOf(chat, ids, read))
  return {
    resourceSpans: trace.resourceSpans.map((resource) => ({
      ...resource,
      scopeSpans: resource.scopeSpans.map((scope) => ({
        ...scope,
        spans: scope.spans.map((span) => {
          const entries = byChat.get(stringAt(span, 'goblin.chat') ?? '') ?? new Map<number, InspectEntry>()
          const added = contentOf(span, entries)
          return added.length === 0 ? span : { ...span, attributes: [...span.attributes, ...added] }
        }),
      })),
    })),
  }
}

/** The trace's id, for the viewer's address. */
export const traceIdOf = (trace: OtlpTraceData): string | undefined => spansOf(trace)[0]?.traceId
