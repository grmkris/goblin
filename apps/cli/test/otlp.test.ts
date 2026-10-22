import type { InspectEntries, InspectEntry, OtlpTraceData } from '@goblin/contracts/inspect'
import { describe, expect, it } from 'vitest'
import { type ReadEntries, traceIdOf, withContent } from '../src/otlp.ts'

type Span = OtlpTraceData['resourceSpans'][number]['scopeSpans'][number]['spans'][number]

const span = (name: string, attributes: Record<string, string | number>): Span => ({
  traceId: 'a'.repeat(32),
  spanId: name.length.toString(16).padStart(16, '0'),
  parentSpanId: '',
  name,
  kind: 1,
  startTimeUnixNano: '1000000',
  endTimeUnixNano: '2000000',
  attributes: Object.entries(attributes).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? { stringValue: value } : { intValue: value },
  })),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  status: { code: 1 },
  links: [],
  droppedLinksCount: 0,
})

const trace: OtlpTraceData = {
  resourceSpans: [
    {
      resource: { attributes: [], droppedAttributesCount: 0 },
      scopeSpans: [
        {
          scope: { name: 'goblin.run-ledger' },
          spans: [
            span('invoke_agent goblin', {
              'goblin.chat': '1',
              'goblin.submission.entry': 10,
              'goblin.submission.answer': 15,
            }),
            span('chat glm-5.1', { 'goblin.chat': '1', 'goblin.entry': 11 }),
            span('execute_tool mcp_call', { 'goblin.chat': '1', 'goblin.entry': 12, 'gen_ai.tool.call.id': 'c1' }),
            span('chat glm-5.1', { 'goblin.chat': '9', 'goblin.entry': 3 }),
          ],
        },
      ],
    },
  ],
}

const entries: readonly InspectEntry[] = [
  { id: 10, kind: 'pi.user', role: 'user', text: 'Cut my video.' },
  {
    id: 11,
    kind: 'pi.assistant',
    role: 'assistant',
    thinking: 'Submit a job.',
    toolCalls: [{ id: 'c1', name: 'mcp_call', arguments: '{"name":"job_submit"}' }],
  },
  {
    id: 12,
    kind: 'pi.tool-result',
    role: 'toolResult',
    text: 'job 7 queued',
    tool: { callId: 'c1', name: 'mcp_call', isError: false },
    truncated: true,
  },
  { id: 15, kind: 'pi.assistant', role: 'assistant', text: 'Queued as job 7.' },
]

/** Main's entries in pages of two, newest first; chat `9` cannot be read. */
const read: ReadEntries = async (chat, before) => {
  if (chat !== '1') return undefined
  const older = entries.filter((entry) => before === undefined || entry.id < before)
  const page = older.slice(-2)
  const first = page[0]
  return {
    conversation: chat,
    entries: page,
    ...(older.length > 2 && first !== undefined ? { before: first.id } : {}),
  } satisfies InspectEntries
}

const attribute = (filled: OtlpTraceData, name: string, key: string) =>
  filled.resourceSpans[0]?.scopeSpans[0]?.spans
    .find((each) => each.name === name)
    ?.attributes.find((each) => each.key === key)?.value

describe('a trace with its words, read on this machine (ADR 0107)', () => {
  it("fills the conventions' content attributes from the entries each span names, paging back as far as needed", async () => {
    const pages: (number | undefined)[] = []
    const filled = await withContent(trace, async (chat, before) => {
      pages.push(before)
      return read(chat, before)
    })
    expect(attribute(filled, 'invoke_agent goblin', 'gen_ai.input.messages')).toEqual({
      stringValue: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Cut my video.' }] }]),
    })
    expect(attribute(filled, 'invoke_agent goblin', 'gen_ai.output.messages')).toEqual({
      stringValue: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Queued as job 7.' }] }]),
    })
    expect(attribute(filled, 'chat glm-5.1', 'gen_ai.output.messages')).toEqual({
      stringValue: JSON.stringify([
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'Submit a job.' },
            { type: 'tool_call', id: 'c1', name: 'mcp_call', arguments: '{"name":"job_submit"}' },
          ],
        },
      ]),
    })
    expect(attribute(filled, 'execute_tool mcp_call', 'gen_ai.tool.call.arguments')).toEqual({
      stringValue: '{"name":"job_submit"}',
    })
    expect(attribute(filled, 'execute_tool mcp_call', 'gen_ai.tool.call.result')).toEqual({
      stringValue: 'job 7 queued',
    })
    expect(attribute(filled, 'execute_tool mcp_call', 'goblin.content.truncated')).toEqual({ boolValue: true })
    // Main was read back to entry 10 and no further; the chat that cannot be read was asked once.
    expect(pages).toEqual([undefined, 12, undefined])
  })

  it('leaves a span whose entries cannot be read as it was, and names the trace', async () => {
    const filled = await withContent(trace, async () => undefined)
    expect(filled).toEqual(trace)
    expect(traceIdOf(trace)).toBe('a'.repeat(32))
  })
})
