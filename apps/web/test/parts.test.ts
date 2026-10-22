import { describe, expect, it } from 'vitest'
import { conversationParts } from '../src/lib/conversation-parts.ts'
import {
  elapsedMs,
  isOwnTurn,
  turnVia,
  type Part,
  partKey,
  samePart,
  toolLine,
  type ToolPart,
  type ToolState,
} from '../src/lib/parts.ts'
import {
  CHAT,
  activity,
  answer,
  asking,
  finished,
  follow,
  result,
  said,
  snapshot,
  started,
  streaming,
} from './agui-fixtures.ts'

const call = (id: string, args: Record<string, unknown> = {}) => ({ id, arguments: args })

/** A Persona fork's native call of `name` (ADR 0101) and its result, whose details say what it reached. */
const native = (name: string, args: Record<string, unknown>, details: unknown, isError = false) => [
  asking(2, [{ id: 'n1', name, arguments: args }]),
  result(3, 'n1', { toolName: name, isError, details, at: 2_000 }),
]

describe("a Persona fork's native MCP calls (ADR 0101)", () => {
  it("reads the server and tool from goblin's own words in the result: a remote result's origin, or its marker", () => {
    const origin = { origin: { connectionId: 'cut', trust: 'untrusted', tool: 'job_submit' } }
    const [done] = conversationParts(snapshot(native('mycut__job_submit', { a: 1 }, origin)))
    expect(done).toMatchObject({ target: { connectionId: 'cut', name: 'job_submit', arguments: { a: 1 } } })
    if (done?.kind !== 'tool') throw new Error('not a tool call')
    expect(toolLine(done)).toEqual({ lead: 'Used', server: 'cut', tool: 'job_submit' })
    const marker = { kind: 'grant-required', connectionId: 'cut', name: 'job_submit', tool: 'mycut__job_submit' }
    const [asked] = conversationParts(snapshot(native('mycut__job_submit', {}, marker, true)))
    expect(asked).toMatchObject({ target: { connectionId: 'cut', name: 'job_submit' } })
    // A marker for another tool, or a call of none of goblin's MCP tools, names nothing.
    const other = { ...marker, tool: 'mycut__job_cancel' }
    expect(conversationParts(snapshot(native('mycut__job_submit', {}, other, true)))[0]).not.toHaveProperty('target')
    expect(conversationParts(snapshot(native('share_back', {}, origin)))[0]).not.toHaveProperty('target')
    // Still pending, the call names nothing yet.
    expect(conversationParts(snapshot(native('mycut__job_submit', {}, origin).slice(0, 1)))[0]).not.toHaveProperty(
      'target',
    )
  })
})

describe('the transcript as render parts', () => {
  it("reads an MCP call's arguments sent as the JSON string of an object", () => {
    const args = { connectionId: 'myplan', name: 'myplan_open', arguments: '{"note":"n1"}' }
    const parts = conversationParts(snapshot([asking(2, [call('c1', args)]), result(3, 'c1')]))
    expect(parts[0]).toMatchObject({
      target: { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } },
    })
  })

  it('folds each result into the call that asked for it, with the MCP target and its timing', () => {
    const args = { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } }
    const parts = conversationParts(snapshot([said(1, 'open it'), asking(2, [call('c1', args)]), result(3, 'c1')]))
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['user', '1:0'],
      ['tool', 'tool:c1'],
    ])
    expect(parts[1]).toMatchObject({
      state: 'done',
      target: { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } },
      startedAt: 1_000,
      endedAt: 4_500,
      result: { text: 'out' },
    })
  })
  it('tells a failed, a queued, a running and a stopped call apart', () => {
    const chat = follow([asking(1, [call('bad'), call('queued'), call('live')]), result(2, 'bad', { isError: true })], {
      running: true,
    })
    const running = chat.next([started('live')], 2_000)
    expect(
      conversationParts(running).map((part) => (part.kind === 'tool' ? [part.id, part.state] : part.kind)),
    ).toEqual([
      ['tool:bad', 'error'],
      ['tool:queued', 'pending'],
      ['tool:live', 'running'],
    ])
    const live = conversationParts(running).find((part) => part.id === 'tool:live')
    expect(live).toMatchObject({ startedAt: 2_000 })
    const ended = chat.next([finished])
    expect(conversationParts(ended).find((part) => part.id === 'tool:queued')).toMatchObject({ state: 'stopped' })
  })
  it('shows the streaming thinking and text, then a live tool whose asking message is not committed yet', () => {
    const next = follow([], { running: true }).next([
      ...streaming(7_000, { thought: 'Plan', text: 'Hi' }),
      { type: 'TOOL_CALL_START', toolCallId: 'early', toolCallName: 'mcp_list', parentMessageId: `${CHAT}:a7000` },
      started('early'),
    ])
    // The order a committed message has, so the tool row does not change places when its message commits.
    expect(conversationParts(next)).toEqual([
      { kind: 'reasoning', id: 'partial:reasoning', key: 'at:7000:reasoning', text: 'Plan', live: true },
      { kind: 'text', id: 'partial:text', key: 'at:7000:text', text: 'Hi', live: true },
      expect.objectContaining({
        kind: 'tool',
        id: 'tool:early',
        state: 'running',
        call: { id: 'early', name: 'mcp_list', arguments: {} },
      }),
    ])
  })
  it('keeps one React key for a message from its first token to its commit, so an open Thoughts stays open', () => {
    const chat = follow([], { running: true })
    const live = conversationParts(chat.next(streaming(7_000, { thought: 'Plan', text: 'Hi' }))).map(partKey)
    const committed = chat.next([
      { type: 'TEXT_MESSAGE_END', messageId: `${CHAT}:a7000`, metadata: { goblin: { entryId: 5, branchable: true } } },
    ])
    const parts = conversationParts(committed)
    expect(live).toEqual(['at:7000:reasoning', 'at:7000:text'])
    expect(parts.map(partKey)).toEqual(live)
    expect(parts.map((part) => part.id)).toEqual(['5:0:reasoning', '5:0:text'])
  })
  it('tells an unchanged part from a changed one across batches, so only changed rows render', () => {
    const entries = [asking(2, [call('c1', { a: 1 })]), result(3, 'c1')]
    const first = conversationParts(snapshot(entries))
    const again = conversationParts(snapshot(entries))
    expect(first.map((part, index) => samePart(part, again[index] ?? part))).toEqual([true])
    const text = { kind: 'text', id: 't', text: 'Hi', live: true } as const
    expect(samePart(text, { ...text })).toBe(true)
    expect(samePart(text, { ...text, text: 'Hi there' })).toBe(false)
    expect(samePart(text, { ...text, live: false })).toBe(false)
    expect(samePart(text, { kind: 'reasoning', id: 't', text: 'Hi', live: true })).toBe(false)
  })
  it('keeps a result whose call was compacted away, and puts a failure after the turn it ended', () => {
    const parts = conversationParts(
      snapshot([result(1, 'gone'), answer(2, { marks: { stop: { reason: 'aborted' } } })]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['tool', 'tool:gone'],
      ['failure', '2:0:failure'],
    ])
  })
})

const toolAt = (state: ToolState, times: { readonly startedAt?: number; readonly endedAt?: number }): ToolPart => ({
  kind: 'tool',
  id: 'tool:c',
  call: { id: 'c', name: 'mcp_list', arguments: {} },
  state,
  ...times,
})

describe('a thread started with + in main', () => {
  it('is its own part between the messages around it', () => {
    const parts = conversationParts(snapshot([said(1, 'hello'), activity(2, 'goblin.thread_started', { thread: '7' })]))
    expect(parts.map((part) => part.kind)).toEqual(['user', 'thread-started'])
    expect(parts[1]).toEqual({ kind: 'thread-started', id: '2:0', thread: '7' })
  })
})

describe("a decided call's outcome kept for the next turn", () => {
  const outcome = {
    continuation: { kind: 'approval', connectionId: 'board', name: 'post', state: 'completed' },
    origin: { connectionId: 'board', trust: 'untrusted' },
    result: { posted: true },
  }
  const words = 'Approved "Board" (board) · post; the held call returned.'
  const kept = said(3, words, { author: 'Board', outcome, kept: true })
  it('is its outcome row, marked as waiting for the next turn while nothing came after it', () => {
    const [part] = conversationParts(snapshot([kept]))
    expect(part).toMatchObject({ kind: 'user', author: 'Board', outcome, kept: true })
  })
  it('reads as any other outcome once something follows it', () => {
    const next = said(4, 'what did it say?')
    const [part] = conversationParts(snapshot([kept, next]))
    expect(part).toMatchObject({ kind: 'user', outcome })
    expect(part).not.toHaveProperty('kept')
    // The same outcome sent as a turn is never marked.
    const sent = said(3, words, { author: 'Board', outcome })
    expect(conversationParts(snapshot([sent]))[0]).not.toHaveProperty('kept')
  })
})

describe('how long a tool ran', () => {
  it('counts to now while running and to the result once done', () => {
    expect(elapsedMs(toolAt('running', { startedAt: 1_000 }), 3_500)).toBe(2_500)
    expect(elapsedMs(toolAt('done', { startedAt: 1_000, endedAt: 1_800 }), 9_000)).toBe(800)
  })
  it('has no time without a start, or for a call that never ran', () => {
    expect(elapsedMs(toolAt('running', {}), 3_500)).toBeUndefined()
    expect(elapsedMs(toolAt('stopped', { startedAt: 1_000 }), 3_500)).toBeUndefined()
  })
  it('never goes negative when clocks disagree', () => {
    expect(elapsedMs(toolAt('done', { startedAt: 5_000, endedAt: 4_000 }), 9_000)).toBe(0)
  })
})

describe('a tool call as one line', () => {
  it('names the server and the tool of an MCP call', () => {
    const part: ToolPart = {
      ...toolAt('done', {}),
      call: { id: 'c', name: 'mcp_call', arguments: {} },
      target: { connectionId: 'board', name: 'move', arguments: {} },
    }
    expect(toolLine(part)).toEqual({ lead: 'Used', server: 'board', tool: 'move' })
  })
  it('names the app and the member of an app_call', () => {
    const appCall = { id: 'c', name: 'app_call', arguments: { app: 'reading-list', member: 'add', input: {} } }
    expect(toolLine({ ...toolAt('done', {}), call: appCall })).toEqual({
      lead: 'Used',
      server: 'reading-list',
      tool: 'add',
    })
  })
  it('says what the agent did with its own tools, and names any other', () => {
    expect(toolLine(toolAt('done', {}))).toEqual({ lead: 'Looked up its tools' })
    const other: ToolPart = { ...toolAt('done', {}), call: { id: 'c', name: 'remember', arguments: {} } }
    expect(toolLine(other)).toEqual({ lead: 'Used remember' })
  })
})

const user = (author?: string): Part => ({
  kind: 'user',
  id: 'u',
  text: 'hi',
  ...(author !== undefined && { author }),
})

describe("the owner's own turns", () => {
  it('counts what the owner typed here and requires an own-turn mark for attributed messages', () => {
    expect(isOwnTurn(user())).toBe(true)
    expect(isOwnTurn(user('Chat · Trip planning'))).toBe(false)
  })
  it('leaves out messages from an MCP client, a subagent, a routine or a thread', () => {
    for (const author of ['Claude Code', 'subagent scout', 'Routine', 'thread "Car search"'])
      expect(isOwnTurn(user(author))).toBe(false)
  })
  it("counts a Source's message goblin marked as theirs, and says where it came from", () => {
    const source: Part = { kind: 'user', id: 's', text: 'Book the ferry', author: 'Chat · Trip planning', own: true }
    expect(isOwnTurn(source)).toBe(true)
    expect(turnVia(source)).toBe('Chat')
    expect(turnVia(user('Chat · Trip planning'))).toBeUndefined()
    expect(turnVia(user())).toBeUndefined()
    expect(turnVia(user('Claude Code'))).toBeUndefined()
  })
  it('is never a reply', () => {
    expect(isOwnTurn({ kind: 'text', id: 't', text: 'hi', live: false })).toBe(false)
  })
})

const build = (id: string) => ({ id, name: 'app_build', arguments: { name: 'tapper' } })
const built = (entry: number, toolCallId: string, text: string) =>
  result(entry, toolCallId, { content: text, toolName: 'app_build' })
const active = (version: number, ui: boolean) =>
  JSON.stringify({ status: 'active', app: 'tapper', release: 'r_1', version, tools: [], revision: 1, ui })

describe('app builds in the transcript', () => {
  it('shows an app view under the newest build that has one, and reads failed builds as none', () => {
    const parts = conversationParts(
      snapshot([
        asking(1, [build('b1')], 1_000),
        built(2, 'b1', active(1, true)),
        asking(3, [build('b2')], 3_000),
        built(4, 'b2', JSON.stringify({ status: 'failed', app: 'tapper', problems: [] })),
        asking(5, [build('b3')], 5_000),
        built(6, 'b3', active(2, true)),
        asking(7, [build('b4')], 7_000),
        built(8, 'b4', active(3, false)),
      ]),
    ).filter((part): part is ToolPart => part.kind === 'tool')
    expect(parts.map((part) => part.built)).toEqual([
      { app: 'tapper', version: 1, ui: true, place: false },
      undefined,
      { app: 'tapper', version: 2, ui: true, place: true },
      { app: 'tapper', version: 3, ui: false, place: false },
    ])
  })
})

const answered = (entry: number, text: string) => answer(entry, { text, at: 2_000 })

describe('the working row and the echo of a sent message', () => {
  const owner = said(1, 'hello')
  it('says the turn is under way after the owner’s message and after a tool result, until something streams', () => {
    const afterMessage = conversationParts(snapshot([owner], { running: true }))
    expect(afterMessage.map((part) => part.kind)).toEqual(['user', 'working'])
    const afterTool = conversationParts(snapshot([owner, asking(2, [call('c1')]), result(3, 'c1')], { running: true }))
    expect(afterTool.map((part) => part.kind)).toEqual(['user', 'tool', 'working'])
  })
  it('does not say it while idle, while something shows, or after an answer a finishing turn leaves last', () => {
    expect(conversationParts(snapshot([owner])).some((part) => part.kind === 'working')).toBe(false)
    const writing = follow([owner], { running: true }).next(streaming(7_000, { text: 'Hi' }))
    expect(conversationParts(writing).some((part) => part.kind === 'working')).toBe(false)
    const running = follow([owner], { running: true }).next([
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'mcp_call' },
      started('c1'),
    ])
    expect(conversationParts(running).some((part) => part.kind === 'working')).toBe(false)
    const ending = snapshot([owner, answered(2, 'Done.')], { running: true })
    expect(conversationParts(ending).some((part) => part.kind === 'working')).toBe(false)
  })
  it('shows a message just sent before the stream delivers it, and keeps its key for the server’s entry', () => {
    const echo = { id: 'echo:op-1', text: 'hello', after: 0 }
    const sending = conversationParts(snapshot([]), echo)
    expect(sending).toEqual([
      { kind: 'user', id: 'echo:op-1', key: 'echo:op-1', text: 'hello' },
      { kind: 'working', id: 'working' },
    ])
    const delivered = conversationParts(snapshot([owner], { running: true }), echo)
    expect(delivered.map((part) => [part.kind, part.id, partKey(part)])).toEqual([
      ['user', '1:0', 'echo:op-1'],
      ['working', 'working', 'working'],
    ])
    // The same row throughout: the echo's key is the server's entry's key.
    expect(sending.map(partKey)[0]).toBe(delivered.map(partKey)[0])
  })
  it('leaves an older message alone when the echo’s own has not arrived', () => {
    const echo = { id: 'echo:op-2', text: 'again', after: 1 }
    const parts = conversationParts(snapshot([owner, answered(2, 'Hi')]), echo)
    expect(parts.map((part) => part.id)).toEqual(['1:0', '2:0:text', 'echo:op-2', 'working'])
  })
})

const toolOf = (state: ReturnType<typeof snapshot>) =>
  conversationParts(state).find((part): part is ToolPart => part.kind === 'tool')

describe('a tool row’s time', () => {
  it('keeps the start and end this browser saw after the run ends, not the asking message’s start and the server’s end', () => {
    // The asking message began at 1_000 and the server stamped the result 4_500; the tool ran 10_000 to 19_500 here.
    const chat = follow([said(1, 'go')], { running: true })
    const asked = `${CHAT}:a1000`
    chat.next(
      [
        { type: 'TEXT_MESSAGE_START', messageId: asked, role: 'assistant', metadata: { goblin: { at: 1_000 } } },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'mcp_call', parentMessageId: asked },
        { type: 'TEXT_MESSAGE_END', messageId: asked, metadata: { goblin: { entryId: 2, branchable: true } } },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' },
        { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      ],
      5_000,
    )
    chat.next([started('c1')], 10_000)
    const { metadata, ...done } = result(3, 'c1')
    const state = chat.next(
      [{ type: 'TOOL_CALL_RESULT', messageId: done.id, toolCallId: 'c1', content: 'out', metadata }],
      19_500,
    )
    expect(toolOf(state)).toMatchObject({ state: 'done', startedAt: 10_000, endedAt: 19_500 })
    const ended = chat.next([finished], 20_000)
    expect(toolOf(ended)).toMatchObject({ state: 'done', startedAt: 10_000, endedAt: 19_500 })
  })
  it('falls back to the asking message and the result’s own stamp for a tool this browser did not see run', () => {
    const state = snapshot([asking(2, [call('c1')]), result(3, 'c1')])
    expect(toolOf(state)).toMatchObject({ startedAt: 1_000, endedAt: 4_500 })
  })
})
