import { describe, expect, it } from 'vitest'
import { sinkOutcome, sinkRetryAt } from '../src/sources/sink-result.ts'
import { sinkEcho, sinkEventSelector } from '../src/sources/sink-echo.ts'

const rules = {
  accepted: { pointer: '/result/delivered', equals: true },
  retryable: { pointer: '/result/state', equals: 'try-later' },
  rejected: { pointer: '/result/state', equals: 'refused' },
  retryAt: '/retryAt',
}

describe('generic sink delivery rules', () => {
  it('reads owner-confirmed pointers without assuming a server-specific result shape', () => {
    expect(sinkOutcome({ content: [], structuredContent: { result: { delivered: true } } }, rules)).toBe('accepted')
    expect(sinkOutcome({ content: [], structuredContent: { result: { state: 'try-later' } } }, rules)).toBe('retryable')
    expect(sinkOutcome({ content: [], structuredContent: { result: { state: 'refused' } } }, rules)).toBe('rejected')
    expect(sinkOutcome({ content: [], structuredContent: { result: { delivered: true } }, isError: true }, rules)).toBe(
      'rejected',
    )
  })

  it('keeps missing, conflicting, and unconfigured results unknown', () => {
    expect(sinkOutcome({ content: [] }, rules)).toBe('unknown')
    expect(sinkOutcome({ content: [], structuredContent: { status: 'sent' } }, undefined)).toBe('unknown')
    expect(
      sinkOutcome({ content: [], structuredContent: { result: { delivered: true, state: 'try-later' } } }, rules),
    ).toBe('unknown')
    expect(sinkOutcome({ content: [] }, { accepted: { pointer: '/missing', equals: null } })).toBe('unknown')
  })

  it('uses only a finite nonnegative integer retry time', () => {
    expect(sinkRetryAt({ content: [], structuredContent: { retryAt: 120_000 } }, rules)).toBe(120_000)
    for (const retryAt of [-1, '120000', null, 1.5, Infinity])
      expect(sinkRetryAt({ content: [], structuredContent: { retryAt } }, rules)).toBe(0)
  })

  it('compares complete echo selectors canonically and never suppresses by connection alone', () => {
    const sink = {
      connectionId: 'relay',
      tool: 'chat_send',
      arguments: {},
      echo: { event: 'chat.received', arguments: { b: 2, a: 1 } },
    }
    expect(
      sinkEcho(sink, {
        connectionId: 'relay',
        eventSelector: sinkEventSelector({ event: 'chat.received', arguments: { a: 1, b: 2 } }),
      }),
    ).toBe(true)
    expect(sinkEcho(sink, { connectionId: 'relay', eventSelector: null })).toBe(false)
    const withoutEcho = { connectionId: sink.connectionId, tool: sink.tool, arguments: sink.arguments }
    expect(sinkEcho(withoutEcho, { connectionId: 'relay', eventSelector: null })).toBe(false)
  })
})
