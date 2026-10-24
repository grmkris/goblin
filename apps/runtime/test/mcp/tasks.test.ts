import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { stepOf } from '../../src/chats/send-status.ts'
import { createdTask, taskIdOf, taskOf, taskRefOf } from '../../src/inbound/tasks.ts'
import { conversationId, entryId } from '../../src/pi/context.ts'

const CHAT = '7'
const REF = { workspace: 'ws-a', chat: CHAT, operationId: 'swarmm:dev:conversation:3:12', createdAt: 1_790_000_000_000 }
const NOW = REF.createdAt + 5000

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
let next = 0
/** One Pi entry of the chat holding one model message, numbered in order. */
const entry = (kind: string, message: Message): EntryRecord => {
  next += 1
  return { id: entryId(next), conversationId: conversationId(CHAT), kind, model: [message] }
}
const user = () => entry('pi.user', { role: 'user', content: 'render it', timestamp: next * 1000 })
/** The agent's message calling `tool` (call id `call-<id>`), or answering in words without one. */
const assistant = (tool?: string): EntryRecord => {
  const content: AssistantMessage['content'] =
    tool === undefined
      ? [{ type: 'text', text: 'done' }]
      : [{ type: 'toolCall', id: `call-${tool}`, name: tool, arguments: {} }]
  const message: AssistantMessage = {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: NO_USAGE,
    stopReason: tool === undefined ? 'stop' : 'toolUse',
    timestamp: next * 1000,
  }
  return entry('pi.assistant', message)
}
const result = (tool: string, details?: ToolResultMessage['details']) =>
  entry('pi.toolResult', {
    role: 'toolResult',
    toolName: tool,
    toolCallId: `call-${tool}`,
    content: [],
    isError: false,
    ...(details === undefined ? {} : { details }),
    timestamp: next * 1000,
  })

describe('a send as a task (ADR 0119)', () => {
  it("names its route in an opaque id that reads back, its operation id's colons included", () => {
    const taskId = taskIdOf(REF)
    expect(taskId).toMatch(/^t1\.[\w-]+$/u)
    expect(taskRefOf(taskId)).toEqual(REF)
  })

  it('reads nothing from an id goblin did not make', () => {
    for (const taskId of ['', 'x', 't1.', 't1.!!!', 't2.abc', `t1.${btoa('{"a":1}')}`, 't1.e30'])
      expect(taskRefOf(taskId)).toBeUndefined()
  })

  it('answers a send just accepted as a working task, polled every two seconds for a day', () => {
    expect(createdTask(taskIdOf(REF), REF)).toEqual({
      content: [],
      resultType: 'task',
      taskId: taskIdOf(REF),
      status: 'working',
      statusMessage: 'accepted',
      createdAt: new Date(REF.createdAt).toISOString(),
      lastUpdatedAt: new Date(REF.createdAt).toISOString(),
      ttlMs: 86_400_000,
      pollIntervalMs: 2000,
    })
  })

  it("maps the send's status: working with its step, completed with the answer, cancelled when stopped", () => {
    const taskId = taskIdOf(REF)
    expect(taskOf(taskId, REF, { status: 'queued' }, NOW)).toMatchObject({
      status: 'working',
      statusMessage: 'waiting for its turn',
      lastUpdatedAt: new Date(NOW).toISOString(),
    })
    expect(taskOf(taskId, REF, { status: 'working', step: 'calling mycut__job_submit' }, NOW)).toMatchObject({
      status: 'working',
      statusMessage: 'calling mycut__job_submit',
    })
    expect(taskOf(taskId, REF, { status: 'answered', text: 'pong' }, NOW)).toMatchObject({
      status: 'completed',
      result: {
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { chat: CHAT, operationId: REF.operationId, text: 'pong' },
      },
    })
    expect(taskOf(taskId, REF, { status: 'unanswered', reason: 'aborted' }, NOW)).toMatchObject({ status: 'cancelled' })
    expect(taskOf(taskId, REF, { status: 'unanswered', reason: 'withdrawn' }, NOW)).toMatchObject({
      status: 'cancelled',
    })
  })

  it('completes a send that ended without an answer as an error result, never as a failed task', () => {
    expect(taskOf(taskIdOf(REF), REF, { status: 'unanswered', reason: 'model_error' }, NOW)).toMatchObject({
      status: 'completed',
      result: { isError: true, structuredContent: { reason: 'model_error' } },
    })
  })
})

describe("a working send's step (ADR 0119)", () => {
  it('thinks until a tool it called has no result yet, then names the tool', () => {
    expect(stepOf(CHAT, [user()])).toBe('thinking')
    const calling = [user(), assistant('mycut__job_submit')]
    expect(stepOf(CHAT, calling)).toBe('calling mycut__job_submit')
    expect(stepOf(CHAT, [...calling, result('mycut__job_submit')])).toBe('thinking')
  })

  it('waits for a person while an ask is open', () => {
    const asked = [
      user(),
      assistant('ask_user'),
      result('ask_user', { kind: 'question', questions: [{ id: 'q', prompt: 'Which day?', kind: 'text' }] }),
    ]
    expect(stepOf(CHAT, asked)).toBe('waiting for a person')
  })
})
