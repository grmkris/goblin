import { describe, expect, it } from 'vitest'
import { framesOf, slugFor, textOf } from '../src/follow.ts'

/** A body that arrives in `chunks`, split wherever they split it. */
const bodyOf = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

/** A sign-in reaching `slugs`, as `workspace_list` answers. */
const reaching = (...slugs: readonly string[]) => ({
  callTool: () =>
    Promise.resolve({
      content: [],
      structuredContent: { workspaces: slugs.map((slug) => ({ id: `ws-${slug}`, slug })) },
    }),
})

describe('goblin follow (ADR 0116)', () => {
  it("reads each data frame's JSON, wherever the body's chunks split a line, and skips comments", async () => {
    const frames: unknown[] = []
    const body = bodyOf([
      ': open\n\ndata: {"type":"RUN_STA',
      'RTED"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\n\n',
    ])
    for await (const frame of framesOf(body)) frames.push(frame)
    expect(frames).toEqual([{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' }])
  })

  it('writes the words as they come and a line where a run starts, ends, fails or calls a tool', () => {
    const run = [
      { type: 'MESSAGES_SNAPSHOT', messages: [{}, {}] },
      { type: 'RUN_STARTED', threadId: '7', runId: '7:1' },
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'search_chats' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: ' there' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'STATE_DELTA', delta: [] },
      { type: 'RUN_FINISHED' },
      { type: 'RUN_ERROR', message: 'model_error' },
    ]
    expect(run.map(textOf).join('')).toBe(
      '(2 messages so far)\n▶ working\n→ search_chats\nassistant: Hello there\n■ done\n✗ model_error\n',
    )
    expect(textOf('not an event')).toBe('')
  })

  it("follows a sign-in's only workspace, or the one --workspace names by id or slug", async () => {
    expect(await slugFor(reaching('owner'), undefined)).toBe('owner')
    expect(await slugFor(reaching('owner', 'team'), 'team')).toBe('team')
    expect(await slugFor(reaching('owner', 'team'), 'ws-team')).toBe('team')
    await expect(slugFor(reaching('owner', 'team'), undefined)).rejects.toThrow('--workspace')
    await expect(slugFor(reaching('owner'), 'elsewhere')).rejects.toThrow('does not reach')
  })
})
