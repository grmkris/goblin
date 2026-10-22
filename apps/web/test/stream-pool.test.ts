import { describe, expect, it } from 'vitest'
import { type StreamState, StreamPool } from '../src/lib/stream-pool.ts'
import { opening, said } from './agui-fixtures.ts'
import { Clock, FakeStream, settle } from './stream-fake.ts'

function fixture(max = 8) {
  const clock = new Clock()
  const streams: Record<string, FakeStream> = {}
  const pool = new StreamPool(
    (id) => {
      const stream = (streams[id] ??= new FakeStream())
      if (stream.epochs[0]?.length === 0) stream.write(...opening([said(1, `hello ${id}`)]))
      return stream.dependencies
    },
    { max, idleMs: 10_000, scheduler: clock, now: () => clock.now },
  )
  return { clock, streams, pool }
}

const open = (stream: FakeStream | undefined) => stream?.live.filter(({ closed }) => !closed) ?? []

describe('the stream pool', () => {
  it('shares one stream among everyone following a conversation, until the last lets go', async () => {
    const { streams, pool } = fixture()
    const seen: StreamState[] = []
    const pane = pool.acquire('7', true, (state) => seen.push(state))
    const inline = pool.acquire('7', true, () => undefined)
    await settle()
    expect(streams['7']?.live).toHaveLength(1)
    expect(seen.at(-1)?.status).toBe('connected')
    expect(seen.at(-1)?.projection?.messages).toMatchObject([{ id: '1:0', text: 'hello 7' }])
    pane.release()
    expect(open(streams['7'])).toHaveLength(1)
    inline.release()
    expect(open(streams['7'])).toHaveLength(0)
    expect(pool.live).toBe(0)
  })

  it('suspends a conversation nobody has on screen after a while, and reads on from where it stopped', async () => {
    const { clock, streams, pool } = fixture()
    const states: StreamState[] = []
    const lease = pool.acquire('7', true, (state) => states.push(state))
    await settle()
    lease.setVisible(false)
    clock.advance(9_000)
    expect(pool.live).toBe(1)
    lease.setVisible(true)
    clock.advance(10_000)
    expect(pool.live).toBe(1)
    lease.setVisible(false)
    clock.advance(10_000)
    expect(pool.live).toBe(0)
    expect(states.at(-1)?.status).toBe('suspended')
    expect(open(streams['7'])).toHaveLength(0)
    streams['7']?.write({
      type: 'TEXT_MESSAGE_START',
      messageId: '1:e2',
      role: 'user',
      metadata: { goblin: { entryId: 2 } },
    })
    streams['7']?.write({ type: 'TEXT_MESSAGE_CONTENT', messageId: '1:e2', delta: 'missed' })
    streams['7']?.write({ type: 'TEXT_MESSAGE_END', messageId: '1:e2' })
    lease.setVisible(true)
    await settle()
    expect(streams['7']?.live).toHaveLength(2)
    // The same epoch, read from the offset it stopped at: nothing twice, nothing missed.
    expect(streams['7']?.reads.at(-1)?.offset).toBe('0002')
    expect(states.at(-1)?.projection?.messages.map((message) => message.id)).toEqual(['1:0', '2:0'])
    expect(states.at(-1)?.status).toBe('connected')
  })

  it('keeps within its cap by suspending the least recently seen, never one on screen', async () => {
    const { clock, pool } = fixture(2)
    const old = pool.acquire('1', true, () => undefined)
    clock.advance(10)
    const newer = pool.acquire('2', true, () => undefined)
    await settle()
    old.setVisible(false)
    newer.setVisible(false)
    const states: StreamState[] = []
    pool.acquire('3', true, () => undefined)
    pool.acquire('1', false, (state) => states.push(state))
    expect(pool.live).toBe(2)
    expect(states.at(-1)?.status).toBe('suspended')
    pool.acquire('4', true, () => undefined)
    pool.acquire('5', true, () => undefined)
    expect(pool.live).toBe(3)
  })
})
