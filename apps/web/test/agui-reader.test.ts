import { describe, expect, it, vi } from 'vitest'
import { StreamReader, type StreamStatus } from '../src/lib/agui/reader.ts'
import { chatStream, readEvents } from '../src/lib/event-streams.ts'
import { reportUnexpected } from '../src/lib/unexpected.ts'
import { Clock, FakeStream, settle } from './stream-fake.ts'

const event = (n: number) => ({ type: 'CUSTOM', name: 'test', value: n })

function reading(stream = new FakeStream()) {
  const clock = new Clock()
  const received: unknown[] = []
  const statuses: [StreamStatus, string | undefined, unknown][] = []
  const reader = new StreamReader(
    stream.dependencies,
    (events) => received.push(...events),
    (status, detail, failure) => statuses.push([status, detail, failure]),
    clock,
  )
  return { stream, clock, received, statuses, reader }
}

const kinds = (statuses: readonly [StreamStatus, ...unknown[]][]) => statuses.map(([status]) => status)

describe("a chat's stream as the browser reads it", () => {
  it('reads the opening, then live, each event once, in order', async () => {
    const { stream, received, statuses, reader } = reading()
    stream.opening = [event(1), event(2)]
    reader.reconnect().catch(reportUnexpected)
    await settle()
    expect(received).toEqual([event(1), event(2)])
    stream.write(event(3))
    await settle()
    expect(received).toEqual([event(1), event(2), event(3)])
    expect(stream.open).toHaveLength(1)
    expect(kinds(statuses)).toEqual(['connecting', 'connected'])
    reader.dispose()
    await settle()
    expect(stream.open).toHaveLength(0)
  })

  it('connects again at once, quietly, when the server ends a connection, and opens afresh', async () => {
    const { stream, received, statuses, reader } = reading()
    stream.opening = [event(1)]
    reader.reconnect().catch(reportUnexpected)
    await settle()
    stream.write(event(2))
    stream.end()
    await settle()
    await settle()
    expect(stream.connections).toHaveLength(2)
    // The new connection's opening holds everything so far; the reducer starts over from it.
    expect(received).toEqual([event(1), event(2), event(1), event(2)])
    expect(kinds(statuses)).toEqual(['connecting', 'connected'])
  })

  it('backs off after a dropped connection or an unreachable server, then opens afresh', async () => {
    const { stream, clock, received, statuses, reader } = reading()
    stream.opening = [event(1)]
    reader.reconnect().catch(reportUnexpected)
    await settle()
    stream.drop()
    await settle()
    expect(kinds(statuses).at(-1)).toBe('reconnecting')
    stream.refuse = 'network'
    clock.advance(1_200)
    await settle()
    expect(kinds(statuses).at(-1)).toBe('reconnecting')
    expect(stream.connections).toHaveLength(1)
    stream.refuse = undefined
    stream.opening.push(event(2))
    clock.advance(2_400)
    await settle()
    await settle()
    expect(kinds(statuses).at(-1)).toBe('connected')
    expect(stream.connections).toHaveLength(2)
    expect(received.slice(-2)).toEqual([event(1), event(2)])
  })

  it('gives up a connection that hears nothing, not even a comment, for 45 seconds', async () => {
    const { stream, clock, reader } = reading()
    stream.opening = [event(1)]
    reader.reconnect().catch(reportUnexpected)
    await settle()
    clock.advance(30_000)
    stream.send(': ping\n\n')
    await settle()
    clock.advance(30_000)
    await settle()
    expect(stream.open).toHaveLength(1)
    clock.advance(15_000)
    await settle()
    expect(stream.open).toHaveLength(0)
    clock.advance(1_200)
    await settle()
    await settle()
    expect(stream.open).toHaveLength(1)
  })

  it('stops for a chat out of reach, and says why, with the failure for a lost session', async () => {
    for (const status of [404, 401]) {
      const { stream, clock, statuses, reader } = reading()
      stream.refuse = status
      await reader.reconnect()
      const [kind, detail, failure] = statuses.at(-1) ?? []
      expect(kind).toBe('stopped')
      expect(detail).toContain('ref ref-fake')
      expect(failure).toMatchObject({ _tag: 'StreamRefused', status })
      clock.advance(60_000)
      await settle()
      expect(stream.connections).toHaveLength(0)
    }
  })
})

describe("a chat's stream on the wire, as the browser parses it", () => {
  it('takes each data frame as one event, across chunks, past comments and CRLF line ends', async () => {
    const chunks = ['data: {"a":1}\n\n: ping\n\nda', 'ta: {"b":\ndata: 2}\r\n\r\n', 'data: {"c":3}\n\n']
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const batches: unknown[][] = []
    await readEvents(new Response(body), (events) => batches.push([...events]))
    expect(batches).toEqual([[{ a: 1 }], [{ b: 2 }], [{ c: 3 }]])
  })

  it("opens a chat's stream under the page's workspace, with the session's cookie", async () => {
    const sent: Request[] = []
    vi.stubGlobal('location', new URL('http://app.test/w/acme/c/7'))
    vi.stubGlobal('window', { location: new URL('http://app.test/w/acme/c/7') })
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      sent.push(new Request(new URL(input, 'http://app.test'), init))
      return new Response('')
    })
    try {
      await chatStream('7')(new AbortController().signal)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(new URL(sent[0]?.url ?? '').pathname).toBe('/w/acme/api/conversations/7/stream')
    expect(sent[0]?.headers.get('accept')).toBe('text/event-stream')
    expect(sent[0]?.credentials).toBe('same-origin')
  })
})
