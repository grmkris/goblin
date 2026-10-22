import { describe, expect, it } from 'vitest'
import { StreamReader, type StreamStatus } from '../src/lib/agui/reader.ts'
import { Clock, FakeStream, settle } from './stream-fake.ts'

const event = (n: number) => ({ type: 'CUSTOM', name: 'test', value: n })

function reading(stream = new FakeStream()) {
  const clock = new Clock()
  const received: unknown[] = []
  const statuses: [StreamStatus, string | undefined][] = []
  const reader = new StreamReader(
    stream.dependencies,
    (events) => received.push(...events),
    (status, detail) => statuses.push([status, detail]),
    clock,
    () => clock.now,
  )
  return { stream, clock, received, statuses, reader }
}

describe("a chat's stream as the browser reads it", () => {
  it('reads what was written, then live, each event once, in order', async () => {
    const { stream, received, statuses, reader } = reading()
    stream.write(event(1), event(2))
    await reader.reconnect()
    expect(received).toEqual([event(1), event(2)])
    expect(stream.reads).toEqual([{ url: 'https://app.test/streams/e1', offset: '-1', longPoll: false }])
    expect(stream.live.map(({ offset }) => offset)).toEqual(['0002'])
    stream.write(event(3))
    expect(received).toEqual([event(1), event(2), event(3)])
    expect(statuses.map(([status]) => status)).toEqual(['connecting', 'connected'])
  })

  it('reads on from the last offset when a live read drops, quietly', async () => {
    const { stream, received, statuses, reader } = reading()
    stream.write(event(1))
    await reader.reconnect()
    stream.write(event(2))
    stream.drop()
    stream.write(event(3))
    await settle()
    expect(received).toEqual([event(1), event(2), event(3)])
    expect(stream.reads.at(-1)?.offset).toBe('0002')
    expect(stream.joins).toEqual([1])
    expect(statuses.map(([status]) => status)).toEqual(['connecting', 'connected'])
  })

  it('follows goblin.stream.moved to the next epoch and reads it from its beginning', async () => {
    const { stream, received, reader } = reading()
    stream.write(event(1))
    await reader.reconnect()
    stream.move(event(10))
    await settle()
    expect(stream.joins).toEqual([1, 2])
    expect(stream.reads.at(-1)).toEqual({ url: 'https://app.test/streams/e2', offset: '-1', longPoll: false })
    expect(received.at(-1)).toEqual(event(10))
    stream.write(event(11))
    expect(received.at(-1)).toEqual(event(11))
  })

  it('joins again at once when its link is refused, and backs off when the stream cannot be reached', async () => {
    const { stream, clock, received, statuses, reader } = reading()
    stream.write(event(1))
    await reader.reconnect()
    stream.refuse = 401
    stream.drop()
    await settle()
    // Refused twice in a row: the second is not a stale link, so it waits before trying again.
    expect(stream.joins).toEqual([1, 1])
    expect(statuses.at(-1)?.[0]).toBe('reconnecting')
    stream.refuse = 'network'
    clock.advance(2_400)
    await settle()
    expect(statuses.at(-1)?.[0]).toBe('reconnecting')
    stream.refuse = undefined
    stream.write(event(2))
    clock.advance(4_800)
    await settle()
    expect(statuses.at(-1)?.[0]).toBe('connected')
    expect(received).toEqual([event(1), event(2)])
  })

  it('joins again before its link expires', async () => {
    const { stream, clock, reader } = reading()
    stream.expiresAt = new Date(60_000).toISOString()
    await reader.reconnect()
    clock.now = 50_000
    stream.drop()
    await settle()
    expect(stream.joins).toEqual([1, 1])
  })

  it('reads by long polls where live reads never get through', async () => {
    const { stream, received, reader } = reading()
    stream.liveFails = true
    await reader.reconnect()
    await settle()
    await settle()
    const polls = () => stream.reads.filter(({ longPoll }) => longPoll)
    expect(polls()).toHaveLength(1)
    stream.write(event(1))
    stream.waiting?.()
    await settle()
    expect(received).toEqual([event(1)])
    expect(polls().at(-1)?.offset).toBe('0001')
    reader.dispose()
  })
})
