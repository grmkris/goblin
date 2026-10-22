// A thinking block that still grows after a later block began: providers send a late delta, or the final message holds
// more of it than the deltas did. Its reasoning message is already closed, so nothing more is streamed for it, and the
// stream stays one a stock AG-UI client accepts.
import { type AguiEvent, EventType } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { applyChange, beginMessage, endMessage, syncBlock } from '../../src/streams/live.ts'
import { checked } from './agui-check.ts'

const reasoningAfterEnd = (events: readonly AguiEvent[]): boolean => {
  const ended = new Set<string>()
  for (const event of events) {
    if (event.type === EventType.REASONING_MESSAGE_END) ended.add(event.messageId)
    if (event.type === EventType.REASONING_MESSAGE_CONTENT && ended.has(event.messageId)) return true
  }
  return false
}

describe('a thinking block after a later block began', () => {
  it('streams nothing more for its closed reasoning message', () => {
    const message = beginMessage('7', 1_000)
    const out: AguiEvent[] = []
    applyChange(message, out, { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: '' } })
    applyChange(message, out, { type: 'thinking_delta', contentIndex: 0, delta: 'Seventeen times' })
    applyChange(message, out, { type: 'text_start', contentIndex: 1, block: { type: 'text', text: '' } })
    applyChange(message, out, { type: 'text_delta', contentIndex: 1, delta: '391' })
    applyChange(message, out, { type: 'thinking_delta', contentIndex: 0, delta: ' twenty-three' })
    syncBlock(message, out, 0, { type: 'thinking', thinking: 'Seventeen times twenty-three is 391.' })
    endMessage(message, out)
    expect(reasoningAfterEnd(out)).toBe(false)
    checked(out)
    const reasoning = out.filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
    expect(reasoning.map((event) => (event.type === EventType.REASONING_MESSAGE_CONTENT ? event.delta : ''))).toEqual([
      'Seventeen times',
    ])
  })

  it('still streams the rest of the open one when the message ends', () => {
    const message = beginMessage('7', 1_000)
    const out: AguiEvent[] = []
    applyChange(message, out, { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: '' } })
    applyChange(message, out, { type: 'thinking_delta', contentIndex: 0, delta: 'Almost' })
    syncBlock(message, out, 0, { type: 'thinking', thinking: 'Almost there.' })
    endMessage(message, out)
    checked(out)
    expect(
      out.flatMap((event) => (event.type === EventType.REASONING_MESSAGE_CONTENT ? [event.delta] : [])).join(''),
    ).toBe('Almost there.')
  })
})
