// A send is AG-UI's RunAgentInput (ADR 0111): bodies as `@ag-ui/core`'s own schema makes them and as a stock
// `HttpAgent` sends them read as the owner's words, the operation id and goblin's parts; the last message rules, the
// resume of a question, and what is refused, each with its own reason.
import { HttpAgent } from '@ag-ui/client'
import { RunAgentInputSchema } from '@ag-ui/core/schemas'
import { type AttentionReason, RunInput, runInput } from '@goblin/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type Send, readSend } from '../src/chats/run-input.ts'

const decode = Schema.decodeUnknownSync(RunInput)

/** `body` (as JSON reaches the endpoint) read as a send into chat 7, with `open` the chat's open interrupts. */
const read = (body: unknown, open?: ReadonlyMap<string, AttentionReason>): Send =>
  Effect.runSync(readSend('7', decode(JSON.parse(JSON.stringify(body))), open))

/** Why reading `body` is refused (reading one that is not refused throws). */
const refusal = (body: unknown, open?: ReadonlyMap<string, AttentionReason>): string =>
  Effect.runSync(Effect.flip(readSend('7', decode(body), open))).reason

const user = (content: unknown, id = 'u1') => ({ id, role: 'user', content })
const body = (messages: readonly unknown[], extra: object = {}) => ({
  threadId: '7',
  runId: 'op-1',
  messages,
  ...extra,
})
const selections = [{ kind: 'persona' as const, personaId: 4 }]
/** A message that says something, answering the interrupt `entry` names. */
const resume = (entry: object) => body([user('go on')], { resume: [entry] })

/** A stand-in for the stage's endpoint: the bodies an `HttpAgent` sent, each answered with an empty run. */
const capturing = () => {
  const sent: unknown[] = []
  const run = ['RUN_STARTED', 'RUN_FINISHED'].map(
    (type) => `data: ${JSON.stringify({ type, threadId: '7', runId: 'r' })}\n\n`,
  )
  const fetch = async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'))
    return new Response(run.join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return { sent, fetch }
}

describe('a send as AG-UI input (ADR 0111)', () => {
  it("reads the contract's own body: the words, the run id as the operation, goblin's parts", () => {
    expect(read(runInput('7', { input: 'hello', operationId: 'op-1', selections, personaOrder: 'sequence' }))).toEqual({
      text: 'hello',
      operationId: 'op-1',
      context: { appContext: [], attachments: [], selections, personaOrder: 'sequence' },
    })
  })

  it("reads a body `@ag-ui/core`'s own schema makes, with its empty tools, context and state", () => {
    const made = RunAgentInputSchema.parse({
      threadId: '7',
      runId: 'op-2',
      messages: [user('first', 'a'), { id: 'b', role: 'assistant', content: 'an answer' }, user('second', 'c')],
      tools: [],
      context: [{ description: 'locale', value: 'sl' }],
      state: {},
      forwardedProps: { goblin: { attachments: ['/uploads/plan.md'] }, theirs: true },
    })
    expect(read(made)).toEqual({
      text: 'second',
      operationId: 'op-2',
      context: { appContext: [], attachments: ['/uploads/plan.md'], selections: [] },
    })
  })

  it('reads what a stock HttpAgent sends, turn after turn, whole history and all', async () => {
    const { sent, fetch } = capturing()
    const agent = new HttpAgent({ url: 'https://goblin.example/api/conversations/7/messages', threadId: '7', fetch })
    agent.addMessage({ id: 'u1', role: 'user', content: 'first turn' })
    await agent.runAgent({ runId: 'op-a', forwardedProps: { goblin: { selections } } })
    agent.addMessage({ id: 'a1', role: 'assistant', content: 'an answer' })
    agent.addMessage({
      id: 'u2',
      role: 'user',
      content: [
        { type: 'text', text: 'second ' },
        { type: 'text', text: 'turn' },
      ],
    })
    await agent.runAgent({ runId: 'op-b' })
    expect(sent.map((each) => read(each))).toEqual([
      { text: 'first turn', operationId: 'op-a', context: { appContext: [], attachments: [], selections } },
      { text: 'second turn', operationId: 'op-b', context: { appContext: [], attachments: [], selections: [] } },
    ])
  })

  it('takes only the last message, which must be the user’s text', () => {
    expect(read(body([{ junk: true }, user('mine')])).text).toBe('mine')
    expect(refusal(body([]))).toBe('no_user_message')
    expect(refusal(body([user('mine'), { id: 'a', role: 'assistant', content: 'theirs' }]))).toBe(
      'last_message_not_user',
    )
    expect(refusal(body([{ role: 'user', content: 'no id' }]))).toBe('user_message_shape')
    const image = { type: 'image', source: { type: 'url', value: 'https://example.com/a.png' } }
    expect(refusal(body([user([{ type: 'text', text: 'look' }, image])]))).toBe('non_text_content')
    expect(refusal(body([user('x'.repeat(20_001))]))).toBe('message_too_long')
  })

  it('refuses a body for another chat, and tools or state of its own', () => {
    expect(refusal({ ...body([user('hi')]), threadId: '8' })).toBe('thread_mismatch')
    expect(refusal(body([user('hi')], { tools: [{ name: 'mine', description: 'a client tool' }] }))).toBe(
      'client_tools',
    )
    expect(refusal(body([user('hi')], { state: { draft: 1 } }))).toBe('client_state')
    expect(read(body([user('hi')], { tools: [], state: [] })).text).toBe('hi')
  })

  it('answers an open question with a resumed answer when the message says nothing of its own', () => {
    const open = new Map<string, AttentionReason>([
      ['7:i12', 'question'],
      ['7:i13', 'approval'],
    ])
    const answer = { interruptId: '7:i12', status: 'resolved', payload: 'Square, warm' }
    const history = [user('earlier'), { id: 'a', role: 'assistant', content: 'Which size?' }]
    expect(read(body(history, { resume: [answer] }), open).text).toBe('Square, warm')
    expect(read(body([], { resume: [answer] }), open).text).toBe('Square, warm')
    expect(read(body([user('  ')], { resume: [answer] }), open).text).toBe('Square, warm')
    expect(read(body([user('Square, but say why')], { resume: [answer] }), open).text).toBe('Square, but say why')
  })

  it('takes a cancelled entry as nothing, and refuses one resolved elsewhere, settled or not answered in words', () => {
    const open = new Map<string, AttentionReason>([
      ['7:i12', 'question'],
      ['7:i13', 'approval'],
      ['7:i14', 'connect'],
    ])
    expect(read(resume({ interruptId: '7:i13', status: 'cancelled' }), open).text).toBe('go on')
    expect(read(resume({ interruptId: '7:i99', status: 'cancelled' }), open).text).toBe('go on')
    expect(refusal(resume({ interruptId: '7:i13', status: 'resolved', payload: 'yes' }), open)).toBe(
      'resume:approval:POST /api/mcp/approvals/:id',
    )
    expect(refusal(resume({ interruptId: '7:i14', status: 'resolved' }), open)).toBe(
      'resume:connect:POST /api/mcp/:id/connect',
    )
    expect(refusal(resume({ interruptId: '7:i11', status: 'resolved', payload: 'late' }), open)).toBe(
      'interrupt_not_open',
    )
    expect(refusal(resume({ interruptId: '7:i12', status: 'resolved', payload: { size: 'square' } }), open)).toBe(
      'resume_payload',
    )
  })

  it('reads a replay’s resumed answer without the chat’s interrupts, which its first send settled', () => {
    const answer = { interruptId: '7:i12', status: 'resolved', payload: 'Square' }
    expect(read(body([], { resume: [answer] })).text).toBe('Square')
  })
})
