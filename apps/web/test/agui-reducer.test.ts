import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type ConversationProjection, Projector } from '../src/lib/agui/reducer.ts'
import type { ChatMessage } from '../src/lib/chat-messages.ts'
import { conversationParts } from '../src/lib/conversation-parts.ts'
import { CHAT, activity, answer, follow, said, snapshot, started } from './agui-fixtures.ts'

// The runtime's goldens (`apps/runtime/test/streams/__snapshots__`): each recorded Pi conversation translated to the
// AG-UI events of its stream in both tiers, and the epoch an idle conversation opens with. The browser reads exactly
// these, so the reducer is held to them.

type Golden = { readonly full: unknown[]; readonly answers: unknown[]; readonly open: unknown[] }
const goldens = fileURLToPath(new URL('../../runtime/test/streams/__snapshots__/', import.meta.url).href)
const golden = (name: string): Golden => JSON.parse(readFileSync(`${goldens}${name}.agui.json`, 'utf8'))
const names = readdirSync(goldens).flatMap((file) => /^(.*)\.agui\.json$/u.exec(file)?.[1] ?? [])

/** The projection after each event of `events`, applied one at a time as the stream may deliver them. */
function stepwise(events: readonly unknown[]): ConversationProjection[] {
  const projector = new Projector()
  return events.map((event, index) => projector.apply([event], index))
}

/** What the answers tier leaves of a transcript: no tool results, no thinking, no calls. */
const answersOf = (messages: readonly ChatMessage[]) =>
  messages.flatMap((message): ChatMessage[] => {
    if (message.role === 'tool') return []
    if (message.role !== 'assistant') return [message]
    const { reasoning: _reasoning, ...rest } = message
    return [{ ...rest, toolCalls: [] }]
  })

describe("the runtime's goldens, read by the browser", () => {
  it('finds them', () => {
    expect(names).toEqual(expect.arrayContaining(['plain', 'reasoning', 'tool', 'queue', 'persona', 'error']))
  })

  it.each(names)('%s: the transcript streamed live is the one its next epoch opens with', (name) => {
    const { full, open } = golden(name)
    const live = new Projector().apply(full, 0)
    const opened = new Projector().apply(open, 0)
    expect(live.messages).toEqual(opened.messages)
    expect(live.messages.length).toBeGreaterThan(0)
    expect(live).toMatchObject({ running: false, partial: '', partialReasoning: '', tools: [], progress: 'Ready' })
    // One event at a time, the same.
    expect(stepwise(full).at(-1)?.messages).toEqual(live.messages)
  })

  it.each(names)('%s: the answers tier is the same transcript without thinking and tools', (name) => {
    const { full, answers } = golden(name)
    expect(new Projector().apply(answers, 0).messages).toEqual(answersOf(new Projector().apply(full, 0).messages))
  })

  it('shows thinking as it streams, then the answer, with one timestamp from the first token to the commit', () => {
    const states = stepwise(golden('reasoning').full)
    const thinking = states.find((state) => state.partialReasoning !== '' && state.partial === '')
    const writing = states.find((state) => state.partial !== '')
    const final = states.at(-1)?.messages.find((message) => message.role === 'assistant')
    expect(thinking?.partialAt).toBeDefined()
    expect(writing?.partialReasoning).toBe(thinking?.partialReasoning.length ? writing?.partialReasoning : '')
    expect(final).toMatchObject({ role: 'assistant', reasoning: expect.any(String), timestamp: thinking?.partialAt })
    expect(states.some((state) => state.running && state.progress === 'Agent is working')).toBe(true)
  })

  it('shows a tool running with its name and arguments, its output as it comes, then its result', () => {
    const states = stepwise(golden('tool').full)
    const running = states.find((state) => state.tools.some((tool) => tool.status === 'running'))
    expect(running?.tools[0]).toMatchObject({ callId: 'call-1', name: 'forecast', status: 'running' })
    expect(Object.keys(running?.tools[0]?.args ?? {})).not.toHaveLength(0)
    expect(states.some((state) => state.tools.some((tool) => tool.output !== ''))).toBe(true)
    const final = states.at(-1)
    const parts = final === undefined ? [] : conversationParts(final)
    expect(parts.find((part) => part.kind === 'tool')).toMatchObject({ state: 'done', call: { name: 'forecast' } })
    expect(final?.toolTimes?.get('call-1')).toMatchObject({
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    })
  })

  it('waits on a queued input in the inbox until its turn takes it', () => {
    const states = stepwise(golden('queue').full)
    expect(states.some((state) => state.inbox.length === 1 && state.queued[0]?.id === 11)).toBe(true)
    expect(states.at(-1)?.inbox).toEqual([])
  })

  it("says a retry is waiting, and puts the model's failure on the message", () => {
    const states = stepwise(golden('error').full)
    expect(states.some((state) => state.progress === 'Waiting for model retry')).toBe(true)
    const last = states.at(-1)?.messages.at(-1)
    expect(last).toMatchObject({ role: 'assistant', failure: { provider: expect.any(Boolean) } })
  })

  it("draws a Persona's answer as the Persona's", () => {
    const messages = new Projector().apply(golden('persona').full, 0).messages
    expect(messages.some((message) => message.role === 'persona')).toBe(true)
  })

  it("keeps a Persona's work in its fork apart: a child while it works, its answer the chat's own", () => {
    const { full, answers } = golden('fork')
    const states = stepwise(full)
    const working = states.filter((state) => state.children.length > 0)
    expect(working.length).toBeGreaterThan(0)
    expect(working[0]?.children).toEqual([
      { id: '9', name: 'Squarewave', persona: { id: 4, avatar: { glyph: 'S', hue: 210 } }, partial: '' },
    ])
    // What its answer in flight says stays with it; the chat itself streams nothing and runs nothing meanwhile.
    expect(working.map((state) => state.children[0]?.partial)).toContain('Launch on Monday.')
    for (const state of working)
      expect(state).toMatchObject({ running: false, partial: '', partialReasoning: '', tools: [] })
    const roles = states.at(-1)?.messages.map((message) => message.role)
    expect(roles).toEqual(['user', 'persona'])
    expect(states.at(-1)?.children).toEqual([])
    // The answers tier shows it working by its lifecycle alone.
    const tiered = stepwise(answers)
    expect(tiered.some((state) => state.children.some((child) => child.name === 'Squarewave'))).toBe(true)
    expect(tiered.at(-1)?.children).toEqual([])
  })

  it('carries what a message brought: its files', () => {
    const messages = new Projector().apply(golden('attachments').full, 0).messages
    expect(messages.find((message) => message.role === 'user')).toMatchObject({ attachments: [expect.anything()] })
  })
})

describe('the reducer', () => {
  it('starts over at an epoch’s opening: what streamed before is replaced', () => {
    const chat = follow([said(1, 'hello')], { running: true })
    chat.next([{ type: 'TEXT_MESSAGE_START', messageId: `${CHAT}:a9`, role: 'assistant' }])
    const reopened = chat.next([
      { type: 'MESSAGES_SNAPSHOT', messages: [said(1, 'hello'), ...answer(2, { text: 'Hi' })] },
    ])
    expect(reopened).toMatchObject({ running: false, partial: '' })
    expect(reopened.messages.map((message) => message.id)).toEqual(['1:0', '2:0'])
  })

  it('reads where older history starts, which entries a Thread may start at, and which are left out', () => {
    const { first } = follow(
      [
        said(4, 'hello'),
        answer(5, { text: 'Hi' }),
        said(6, 'moved'),
        activity(7, 'goblin.thread_head', { thread: '9', text: 'moved', operationId: 'op' }, { omits: [6] }),
      ],
      { before: 4 },
    )
    expect(first.historyBefore).toBe(4)
    expect(first.newestEntry).toBe(7)
    expect([...first.branchable]).toEqual([4, 5, 6])
    expect([...first.omitted]).toEqual([6])
    expect(first.messages.map((message) => message.id)).toEqual(['4:0', '5:0', '7:0'])
    expect(snapshot([said(1, 'hi')]).historyBefore).toBeUndefined()
  })

  it('keeps the committed messages, and what they give, the same objects while only text streams', () => {
    const chat = follow([said(1, 'hello')], { running: true })
    const before = chat.next([{ type: 'TEXT_MESSAGE_START', messageId: `${CHAT}:a9`, role: 'assistant' }])
    const after = chat.next([{ type: 'TEXT_MESSAGE_CONTENT', messageId: `${CHAT}:a9`, delta: 'Hi' }])
    expect(after.partial).toBe('Hi')
    expect(after.messages).toBe(before.messages)
    expect(after.branchable).toBe(before.branchable)
  })

  it("keeps a child's own events with it, and forgets its children at an epoch's opening", () => {
    const chat = follow([said(1, 'go')])
    const child = { subagentRunId: '7' }
    const working = chat.next([
      { type: 'SUBAGENT_STARTED', name: 'scout', ...child },
      { type: 'TEXT_MESSAGE_START', messageId: '7:a5', role: 'assistant', ...child },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: '7:a5', delta: 'Looking', ...child },
      { type: 'TOOL_CALL_START', toolCallId: '7:c1', toolCallName: 'fetch', parentMessageId: '7:a5', ...child },
      { ...started('7:c1'), ...child },
    ])
    expect(working.children).toEqual([{ id: '7', name: 'scout', partial: 'Looking' }])
    expect(working).toMatchObject({ partial: '', tools: [] })
    const ended = chat.next([
      { type: 'TEXT_MESSAGE_END', messageId: '7:a5', ...child },
      { type: 'SUBAGENT_FINISHED', outcome: { type: 'success' }, ...child },
    ])
    expect(ended.children).toEqual([])
    expect(ended.messages.map((message) => message.role)).toEqual(['user'])
    // The events of a child never started, or one an epoch's opening forgot, are read past.
    chat.next([{ type: 'SUBAGENT_STARTED', name: 'scout', ...child }])
    const reopened = chat.next([{ type: 'MESSAGES_SNAPSHOT', messages: [said(1, 'go')] }])
    expect(reopened.children).toEqual([])
    const stray = chat.next([{ type: 'TEXT_MESSAGE_START', messageId: '7:a6', role: 'assistant', ...child }])
    expect(stray).toMatchObject({ children: [], partial: '' })
  })

  it('ends a nested call’s live row with its result, without a transcript message', () => {
    const chat = follow([said(1, 'go')], { running: true })
    const nested = { metadata: { goblin: { parentToolCallId: 'outer' } } }
    chat.next([
      { type: 'TOOL_CALL_START', toolCallId: 'inner', toolCallName: 'fetch', ...nested },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'inner', delta: '{"url":"https://example.com"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'inner' },
      started('inner'),
    ])
    const done = chat.next([
      {
        type: 'TOOL_CALL_RESULT',
        messageId: `${CHAT}:tinner`,
        toolCallId: 'inner',
        content: 'ok',
        role: 'tool',
        ...nested,
      },
    ])
    expect(done.tools).toMatchObject([
      { callId: 'inner', name: 'fetch', status: 'done', args: { url: 'https://example.com' } },
    ])
    expect(done.messages.map((message) => message.role)).toEqual(['user'])
  })
})
