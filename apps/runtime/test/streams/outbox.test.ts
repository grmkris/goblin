// The stream writes as SQLite keeps them and as the stream objects answer them: an epoch begins with its create and
// the old epoch's move and close, appends keep their sequence numbers, and a write's answer decides whether it went.
import { EventType } from '@goblin/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { startCursor } from '../../src/streams/agui.ts'
import { bodiesOf, cursorJson, movedBody, storedCursor } from '../../src/streams/bodies.ts'
import { keyParts } from '../../src/streams/outbox.ts'
import {
  acknowledged,
  allStreams,
  appendWrites,
  beginEpoch,
  dropEpoch,
  forgetStreams,
  pendingWrites,
  streamKey,
  unsentStreams,
} from '../../src/streams/store.ts'
import { STREAM_TTL_SECONDS, send, streamPath } from '../../src/streams/writer.ts'
import { type ChatDatabase, chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const each of open.splice(0)) each.close()
})
const database = (): ChatDatabase => {
  const made = chatDatabase()
  open.push(made)
  return made.db
}

/** A text delta of a hundred thousand characters. */
const delta = (index: number) => ({
  type: EventType.TEXT_MESSAGE_CONTENT as const,
  messageId: '1:a1',
  delta: `${index}`.repeat(100_000),
})

/** A stream object that answers `status` and keeps the requests it got. */
const object = (status: number | 'throws') => {
  const got: Request[] = []
  const fetchStream = async (request: Request) => {
    got.push(request)
    if (status === 'throws') throw new Error('network')
    return new Response(null, { status })
  }
  return { got, fetchStream }
}

const row = (epoch: number, nextSeq: number) => ({
  chat: '7',
  tier: 'answers' as const,
  epoch,
  nextSeq,
  bytes: 10,
  startedAt: 1,
  cursorJson: cursorJson(startCursor('7')),
})

describe('the outbox', () => {
  it('begins an epoch with its create after the old one moved and closed, and acknowledges writes one by one', () => {
    const db = durable(database())
    const key = streamKey('7', 'answers')
    beginEpoch(db, row(1, 0), [{ seq: -1, body: '[1]' }])
    appendWrites(db, row(1, 2), [
      { seq: 0, body: '[2]' },
      { seq: 1, body: '[3]' },
    ])
    beginEpoch(db, row(2, 0), [{ seq: -1, body: '[4]' }], {
      epoch: 1,
      writes: [
        { seq: 2, body: movedBody(2) },
        { seq: 3, body: '' },
      ],
    })
    expect(pendingWrites(db, key).map(({ epoch, seq }) => `${epoch}:${seq}`)).toEqual([
      '1:-1',
      '1:0',
      '1:1',
      '1:2',
      '1:3',
      '2:-1',
    ])
    expect(allStreams(db)).toEqual([row(2, 0)])
    expect(unsentStreams(db)).toEqual([key])
    const [first] = pendingWrites(db, key)
    if (first !== undefined) acknowledged(db, key, first)
    dropEpoch(db, key, 1)
    expect(pendingWrites(db, key)).toEqual([{ epoch: 2, seq: -1, body: '[4]' }])
    forgetStreams(db)
    expect([allStreams(db), unsentStreams(db)]).toEqual([[], []])
    expect(keyParts(key)).toEqual({ chat: '7', tier: 'answers' })
  })

  it('keeps a cursor only in the version it was written in', () => {
    const cursor = startCursor('7')
    expect(storedCursor(cursorJson(cursor))).toEqual(cursor)
    expect(storedCursor(JSON.stringify({ v: 0, cursor }))).toBeUndefined()
    expect(storedCursor('not json')).toBeUndefined()
  })

  it('splits events into bodies that each fit an append, in order', () => {
    const events = Array.from({ length: 12 }, (_, index) => delta(index))
    const bodies = bodiesOf(events)
    expect(bodies.length).toBeGreaterThan(1)
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(512 * 1024)
    expect(bodies.flatMap((body) => JSON.parse(body))).toEqual(events)
    expect(bodiesOf([])).toEqual([])
  })
})

describe('a write as a stream object answers it', () => {
  const path = streamPath('ws-1', '7', 'full', 3)

  it('creates with its TTL, appends and closes as the one producer, with the sequence number', async () => {
    const { got, fetchStream } = object(201)
    expect(await send(fetchStream, path, { seq: -1, body: '[]' })).toBe('ok')
    expect(await send(fetchStream, path, { seq: 4, body: '[1]' })).toBe('ok')
    expect(await send(fetchStream, path, { seq: 5, body: '' })).toBe('ok')
    expect(got.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['PUT', '/s/ws-1/7/full/3'],
      ['POST', '/s/ws-1/7/full/3'],
      ['POST', '/s/ws-1/7/full/3'],
    ])
    const [create, append, close] = got
    expect(create?.headers.get('stream-ttl')).toBe(String(STREAM_TTL_SECONDS))
    expect(create?.headers.get('content-type')).toBe('application/json')
    expect([append?.headers.get('producer-id'), append?.headers.get('producer-seq')]).toEqual(['goblin', '4'])
    expect(close?.headers.get('stream-closed')).toBe('true')
  })

  it('counts a duplicate as sent, retries what may not have arrived, and tells gone from out of step', async () => {
    const write = { seq: 1, body: '[1]' }
    expect(await send(object(204).fetchStream, path, write)).toBe('ok')
    expect(await send(object(503).fetchStream, path, write)).toBe('retry')
    expect(await send(object('throws').fetchStream, path, write)).toBe('retry')
    expect(await send(object(404).fetchStream, path, write)).toBe('gone')
    expect(await send(object(409).fetchStream, path, write)).toBe('broken')
    expect(await send(object(403).fetchStream, path, write)).toBe('broken')
  })
})
