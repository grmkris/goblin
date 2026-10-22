import { describe, expect, it } from 'vitest'
import * as Schema from 'effect/Schema'
import { type EventDescriptor, EventsListResult, eventWords } from '../../src/mcp/events/protocol.ts'

const descriptor = (extra: Partial<EventDescriptor>): EventDescriptor => ({
  name: 'notes.post.created',
  inputSchema: {},
  delivery: ['poll', 'webhook'],
  ...extra,
})

describe("an event's own words, by its standard fields only (ADR 0068)", () => {
  it('reads the title folded to one bounded line and the description cut', () => {
    expect(eventWords(descriptor({ title: 'Post\ncreated\u0000', description: 'A post reached your feed' }))).toEqual({
      title: 'Post created',
      description: 'A post reached your feed',
    })
    expect(eventWords(descriptor({ title: 'x'.repeat(500) })).title).toHaveLength(120)
    expect(eventWords(descriptor({ description: 'y'.repeat(900) })).description).toHaveLength(500)
  })

  it('drops a title that is not text, and reads nothing from _meta', () => {
    expect(eventWords(descriptor({ title: 42 }))).toEqual({})
    const decoded = Schema.decodeUnknownSync(EventsListResult)({
      events: [
        {
          name: 'post.created',
          inputSchema: {},
          delivery: ['poll', 'webhook'],
          _meta: { suggest: { title: 'Suggested', recommended: true, tellMe: true, rate: 'often' } },
        },
      ],
    })
    const [event] = decoded.events
    expect(event).not.toHaveProperty('_meta')
    expect(event === undefined ? undefined : eventWords(event)).toEqual({})
  })
})

describe('an event list with delivery modes goblin does not know', () => {
  it('decodes, keeping the modes it knows usable', () => {
    const decoded = Schema.decodeUnknownSync(EventsListResult)({
      events: [{ name: 'notes.changed', inputSchema: {}, delivery: ['poll', 'webhook', 'push'] }],
    })
    expect(decoded.events[0]?.delivery).toEqual(['poll', 'webhook', 'push'])
    expect(decoded.events[0]?.delivery.includes('webhook')).toBe(true)
  })
})
