import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { authorTag } from '@goblin/contracts'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
import { inspectEntry, ranWithOf, stepsOf, summarize } from '../src/inspect/inspector.ts'
import { conversationId, entryId } from '../src/pi/context.ts'

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const answer = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'test',
  provider: 'openai',
  model: 'gpt-test',
  usage: usage(120, 30),
  stopReason: 'toolUse',
  timestamp: 1000,
})

const entry = (kind: string, message: Message): EntryRecord => ({
  id: entryId(7),
  conversationId: conversationId('1'),
  kind,
  model: [message],
})

describe('inspectEntry', () => {
  it('names the author a tag block carries and keeps only the words', () => {
    const view = inspectEntry(
      entry('pi.user', {
        role: 'user',
        content: [
          { type: 'text', text: authorTag('Chat') },
          { type: 'text', text: 'what is on today?' },
        ],
        timestamp: 500,
      }),
    )
    expect(view).toEqual({
      id: 7,
      kind: 'pi.user',
      role: 'user',
      author: 'Chat',
      text: 'what is on today?',
      at: 500,
    })
  })

  it("keeps an answer's visible thinking and leaves redacted thinking out", () => {
    const view = inspectEntry(
      entry(
        'pi.assistant',
        answer([
          { type: 'thinking', thinking: ' Plan the app first. ' },
          { type: 'thinking', thinking: 'opaque', redacted: true },
          { type: 'text', text: 'Building it.' },
        ]),
      ),
    )
    expect(view).toMatchObject({ thinking: 'Plan the app first.', text: 'Building it.' })
    expect(view.truncated).toBeUndefined()
    const long = inspectEntry(entry('pi.assistant', answer([{ type: 'thinking', thinking: 'z'.repeat(5000) }])))
    expect(long.thinking).toHaveLength(4001)
    expect(long.truncated).toBe(true)
  })

  it('cuts long text and long arguments, and says so', () => {
    const view = inspectEntry(
      entry(
        'pi.assistant',
        answer([
          { type: 'text', text: 'x'.repeat(5000) },
          { type: 'toolCall', id: 'call-1', name: 'mcp_call', arguments: { body: 'y'.repeat(3000) } },
        ]),
      ),
    )
    expect(view.truncated).toBe(true)
    expect(view.text).toHaveLength(4001)
    expect(view.toolCalls?.[0]?.name).toBe('mcp_call')
    expect(view.toolCalls?.[0]?.arguments).toHaveLength(2001)
    expect(view.model).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      stopReason: 'toolUse',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 3,
    })
  })

  it('says which call a tool result answers and whether it failed', () => {
    const view = inspectEntry(
      entry('pi.tool-result', {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'mcp_call',
        content: [{ type: 'text', text: 'server refused' }],
        isError: true,
        timestamp: 2000,
      }),
    )
    expect(view).toMatchObject({ text: 'server refused', tool: { callId: 'call-1', name: 'mcp_call', isError: true } })
    expect(view.truncated).toBeUndefined()
  })

  it("keeps Pi's own data for an entry without a message", () => {
    const view = inspectEntry({ id: entryId(9), conversationId: conversationId('1'), kind: 'app.note', data: { a: 1 } })
    expect(view).toEqual({ id: 9, kind: 'app.note', data: '{"a":1}' })
  })
})

const event = (
  kind: RunEvent['kind'],
  status: RunEvent['status'],
  attributes: RunEvent['attributes'] = {},
): RunEvent => ({
  id: `${kind}:${status}:${JSON.stringify(attributes)}`,
  kind,
  status,
  operationId: 'op-1',
  conversationId: '1',
  startedAt: 10,
  endedAt: 20,
  attributes,
})

/** A step event of `kind` from `startedAt` to `endedAt` (still running without one). */
const at = (kind: RunEvent['kind'], startedAt: number, endedAt: number | undefined, id: string): RunEvent => ({
  ...event(kind, 'ok'),
  id,
  startedAt,
  ...(endedAt === undefined ? { endedAt: undefined, status: 'started' as const } : { endedAt }),
})

describe('summarize', () => {
  it('counts attempts, calls and failures, and sums tokens', () => {
    const turn = event('turn.submitted', 'error', {
      [RunAttribute.source]: 'source',
      [RunAttribute.reason]: 'model_error',
    })
    const summary = summarize(turn, [
      turn,
      event('model.attempt', 'error', { [RunAttribute.inputTokens]: 100 }),
      event('model.attempt', 'ok', { [RunAttribute.inputTokens]: 110, [RunAttribute.outputTokens]: 12 }),
      event('tool.call', 'blocked'),
      event('tool.call', 'ok'),
      event('error', 'error', { [RunAttribute.taskKind]: 'subagent.relay' }),
    ])
    expect(summary).toEqual({
      operationId: 'op-1',
      conversationId: '1',
      source: 'source',
      status: 'error',
      reason: 'model_error',
      startedAt: 10,
      endedAt: 20,
      modelAttempts: 2,
      failedAttempts: 1,
      toolCalls: 2,
      failedToolCalls: 1,
      inputTokens: 210,
      outputTokens: 12,
      errors: 1,
    })
  })
})

describe('what a turn ran with (ADR 0107)', () => {
  const release = 'a'.repeat(40)
  const next = 'b'.repeat(40)
  const turn = event('turn.submitted', 'ok', { [RunAttribute.agentVersion]: release })
  const first = {
    ...event('model.attempt', 'ok', {
      [RunAttribute.agentVersion]: release,
      [RunAttribute.modelEndpoint]: 'deployment',
      [RunAttribute.reasoningLevel]: 'medium',
      [RunAttribute.promptSections]: 'persona,skills',
      [RunAttribute.toolsAdded]: 2,
      [RunAttribute.toolsChanged]: 'mycut__job_submit,mycut__job_status',
    }),
    taskId: 'g1',
  }
  const call = { ...event('tool.call', 'ok', { [RunAttribute.mcpServer]: 'mycut' }), taskId: 't1' }
  const request = {
    ...event('mcp.request', 'ok', {
      [RunAttribute.mcpServer]: 'mycut',
      [RunAttribute.mcpServerName]: 'my_cut',
      [RunAttribute.mcpServerVersion]: '1.4.2',
    }),
    taskId: 't1',
  }
  // The agent restarted into a new release mid-turn, and the prompt was restated after compaction: no change.
  const second = {
    ...event('model.attempt', 'ok', {
      [RunAttribute.agentVersion]: next,
      [RunAttribute.modelEndpoint]: 'deployment',
      [RunAttribute.reasoningLevel]: 'medium',
      [RunAttribute.promptSections]: 'persona,skills',
      [RunAttribute.promptBaseline]: true,
      [RunAttribute.toolsAdded]: 2,
    }),
    taskId: 'g1',
  }
  const events = [turn, first, call, request, second]

  it('says it on each step, the MCP call naming the server as its request found it', () => {
    const [attempt, tool, restated] = stepsOf(turn, events)
    expect(attempt).toMatchObject({
      version: release,
      endpoint: 'deployment',
      thinking: 'medium',
      promptSections: ['persona', 'skills'],
      toolsAdded: 2,
      toolsChanged: ['mycut__job_submit', 'mycut__job_status'],
    })
    expect(tool).toMatchObject({ server: 'mycut', serverName: 'my_cut', serverVersion: '1.4.2' })
    expect(restated).toMatchObject({ version: next, promptBaseline: true })
    expect(summarize(turn, events).version).toBe(release)
  })

  it('gives a failed step its fixed summary, and a step that did not fail none', () => {
    const failed = {
      ...event('tool.call', 'error', {
        [RunAttribute.toolName]: 'mcp_call',
        [RunAttribute.errorType]: 'UpstreamMcp:timeout',
        [RunAttribute.error]: 'Remote MCP request failed (timeout).',
      }),
      taskId: 't9',
    }
    const blocked = event('tool.call', 'blocked', { [RunAttribute.error]: 'Owner grant required.' })
    const [failedStep, blockedStep] = stepsOf(turn, [turn, failed, blocked])
    expect(failedStep).toMatchObject({
      errorType: 'UpstreamMcp:timeout',
      error: 'Remote MCP request failed (timeout).',
    })
    expect(blockedStep?.error).toBeUndefined()
  })

  it('lists steps in the order they ran: of two that started together, the one that ended first', () => {
    const ordered = stepsOf(turn, [
      turn,
      at('model.attempt', 10, 13, 'a1'),
      at('model.attempt', 13, 20, 'a2'),
      at('tool.call', 13, 13, 't1'),
      at('model.attempt', 20, undefined, 'a3'),
      at('tool.call', 20, 21, 't2'),
    ])
    expect(ordered.map((step) => [step.kind, step.offsetMs])).toEqual([
      ['model.attempt', 0],
      ['tool.call', 3],
      ['model.attempt', 3],
      ['tool.call', 10],
      ['model.attempt', 10],
    ])
  })

  it('sums it up once for the turn', () => {
    expect(ranWithOf(events)).toEqual({
      versions: [release, next],
      endpoints: ['deployment'],
      thinking: ['medium'],
      promptChanges: 1,
      servers: [{ server: 'mycut', name: 'my_cut', version: '1.4.2' }],
    })
  })
})
