import { describe, expect, it } from 'vitest'
import { SseDecoder, readSse } from '../src/sse.ts'

describe('SseDecoder', () => {
  it('joins split chunks and multiline data without losing the frame boundary', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('event: batch\r\ndata: {"a":')).toEqual([])
    expect(decoder.push('1}\r\ndata: second\r\n\r\nevent: snapshot\ndata: {}\n\n')).toEqual([
      { event: 'batch', data: '{"a":1}\nsecond' },
      { event: 'snapshot', data: '{}' },
    ])
  })

  it('handles empty data, CRLF split between chunks, cancellation, and bad responses', async () => {
    const decoder = new SseDecoder()
    expect(decoder.push('event: ping\r')).toEqual([])
    expect(decoder.push('\ndata:\r\n\r\n')).toEqual([{ event: 'ping', data: '' }])
    const controller = new AbortController()
    const cancelled = new Promise<void>((resolve) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('data: ok\n\n'))
          },
          cancel() {
            resolve()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
      void readSse(response, controller.signal, () => controller.abort()).catch(() => {
        // expected: aborting the fixture stream may reject its reader.
      })
    })
    await cancelled
    await expect(readSse(new Response('nope'), new AbortController().signal, () => undefined)).rejects.toThrow(
      'event stream',
    )
  })
})
