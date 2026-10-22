import { describe, expect, it } from 'vitest'
import { eventMetadata } from '../src/routines/event-data.ts'

/** The 16 KiB of event data a run reads, as the docs and ADR 0104 state it. */
const EVENT_DATA_BYTES = 16_384

const name = 'mysi.workflow_completed'
const timestamp = '2026-10-22T01:00:00.000Z'

describe("a routine event's data reaches its run as the producer sent it (ADR 0104)", () => {
  it('keeps compact JSON byte for byte: a link with its query and the fields after it', () => {
    const producer =
      '{"outputs":{"shareUrl":"https://media.test/f/a.mp4?t=T0k3n&dl=1#t=3","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"},"artifactId":"art_1","accessToken":"producer-sent","note":"Bearer x"}'
    expect(eventMetadata({ name, timestamp, data: JSON.parse(producer) })).toBe(
      `{"name":"${name}","timestamp":"${timestamp}","data":${producer}}`,
    )
  })

  it('keeps a link with no query, and non-ASCII and escaped text, as JSON', () => {
    const producer = '{"url":"https://media.test/f/b.mp4","title":"Café \u202e \\"quoted\\"\\n","n":[1,2.5,null,true]}'
    expect(eventMetadata({ name, timestamp, data: JSON.parse(producer) })).toBe(
      `{"name":"${name}","timestamp":"${timestamp}","data":${producer}}`,
    )
  })

  it('leaves data over the limit out whole, with a note, and never cuts it', () => {
    const data = { blob: 'x'.repeat(EVENT_DATA_BYTES), shareUrl: 'https://media.test/f/a.mp4?t=T0k3n' }
    const bytes = JSON.stringify(data).length
    const metadata = eventMetadata({ name, timestamp, data })
    expect(JSON.parse(metadata)).toEqual({
      name,
      timestamp,
      dataOmitted: `The event's data was ${String(bytes)} bytes, over the ${String(EVENT_DATA_BYTES)} a run reads; read it with the server's tools.`,
    })
    expect(metadata).not.toContain('xxxx')
    expect(metadata).not.toContain('media.test')
  })

  it('counts bytes, not characters, and keeps data exactly at the limit', () => {
    const fits = { s: 'x'.repeat(EVENT_DATA_BYTES - '{"s":""}'.length) }
    expect(JSON.parse(eventMetadata({ name, timestamp, data: fits }))).toEqual({ name, timestamp, data: fits })
    const wide = { s: 'é'.repeat((EVENT_DATA_BYTES - '{"s":""}'.length) / 2 + 1) }
    expect(JSON.parse(eventMetadata({ name, timestamp, data: wide }))).not.toHaveProperty('data')
  })
})
