// The attention a `conversation.updated` reports (ADR 0112) is its chat stream's `/attention`, over the same Pi
// recordings the stream's goldens are made from (`test/streams/fixtures/`).
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { foldAttention, topicOfWake, wakeOf } from '../../src/publish/payload.ts'
import { open, startCursor, translate } from '../../src/streams/agui.ts'
import type { Recording } from '../streams/scenarios.ts'

const fixtures = new URL('../streams/fixtures/', import.meta.url)
const recordings = readdirSync(fileURLToPath(fixtures.href))
  .filter((file) => file.endsWith('.json'))
  .map((file): [string, Recording] => [
    file.replace(/\.json$/u, ''),
    JSON.parse(readFileSync(fileURLToPath(new URL(file, fixtures).href), 'utf8')),
  ])

describe("a chat's attention count", () => {
  it.each(recordings)('%s: is the length of its stream’s /attention, read whole or as it goes', (_name, recording) => {
    const { chat, final, batches } = recording
    const opened = open(chat, final, { window: 50 }).cursor.state.attention
    const live = batches.reduce((cursor, batch) => translate(cursor, batch).cursor, startCursor(chat)).state.attention
    const whole = foldAttention(chat, undefined, final.entries)
    expect(whole.open.length).toBe(opened.length)
    expect(whole.open.map(({ id }) => id)).toEqual(live.map(({ id }) => id))
    // Seeded from the first entries, then advanced over the rest: the same as reading them all at once.
    const half = Math.ceil(final.entries.length / 2)
    const seeded = foldAttention(chat, undefined, final.entries.slice(0, half))
    const advanced = foldAttention(chat, seeded, final.entries)
    expect(advanced).toEqual(whole)
    expect(whole.last).toBe(Math.max(0, ...final.entries.map(({ id }) => Number(id))))
  })

  it('counts what waits in the recordings that leave something open', () => {
    const waiting = Object.fromEntries(
      recordings.map(([name, { chat, final }]) => [name, foldAttention(chat, undefined, final.entries).open.length]),
    )
    expect(waiting).toMatchObject({ question: 1, persona: 1, plain: 0 })
  })
})

describe("a chat's wake", () => {
  it('says its chat, its Topic (none in Personal), its newest entry, whether it works and what waits', () => {
    const fold = { last: 12, open: [] }
    expect(wakeOf({ chat: '7', topicId: 1 }, fold, true)).toEqual({
      chat: '7',
      topic: null,
      entry: 12,
      activity: 'working',
      attention: 0,
    })
    const room = wakeOf({ chat: '40', topicId: 4 }, fold, false)
    expect(room).toMatchObject({ topic: '4', activity: 'idle' })
    expect(topicOfWake(room)).toBe(4)
    expect(topicOfWake(wakeOf({ chat: '7', topicId: 1 }, fold, false))).toBe(1)
  })
})
