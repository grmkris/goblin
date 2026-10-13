import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { telegramChannel } from '../src/channel/channel.ts'
import type { ChannelCall } from '../src/channel/tools.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

/** A channel server that cannot be reached. */
const unreachable: ChannelCall = () => Effect.fail(new UpstreamMcp({ connectionId: 'mygram', reason: 'transport' }))

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** A real channel on SQLite, and the channel server's inbox answering from `pages` (one inbox page per call). */
const fixture = (pages: number) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const channel = yield* telegramChannel({ db: durable(db), telemetry: undefined, wake: () => undefined })
    const calls: string[] = []
    const call: ChannelCall = (name, args) =>
      Effect.sync(() => {
        const cursor = args['cursor']
        const chat = args['chat']
        calls.push(`${name}:${typeof cursor === 'string' ? cursor : ''}:${typeof chat === 'string' ? chat : ''}`)
        const page = calls.length
        const messages = page <= pages ? [{ id: `m${page}`, text: 'old', direction: 'in' }] : []
        return { messages, nextCursor: `c${page}` }
      })
    return { channel, call, calls }
  })

describe('turning the Telegram channel on', () => {
  it.effect('reads every chat to the end of its inbox, so its history is not taken for new messages', () =>
    Effect.gen(function* () {
      const { channel, call, calls } = yield* fixture(2)
      const cursor = yield* channel.startCursor('mygram', call, { chat: 'all' })
      expect(cursor).toBe('c3')
      expect(calls).toEqual(['inbox::all', 'inbox:c1:all', 'inbox:c2:all'])
      const status = yield* channel.enableEvents('mygram', cursor, 100, { reach: 'all' })
      expect(status).toEqual({
        connectionId: 'mygram',
        enabledAt: 100,
        transport: 'events',
        reach: 'all',
        newChats: 'ask',
      })
      expect(yield* channel.startCursor('mygram', call)).toBe('c3')
      expect(calls).toHaveLength(3)
    }),
  )

  it.effect("fails with the channel server's own failure, unchanged", () =>
    Effect.gen(function* () {
      const { channel } = yield* fixture(0)
      const failed = yield* Effect.flip(channel.startCursor('mygram', unreachable))
      expect(failed).toMatchObject({ _tag: 'UpstreamMcp', reason: 'transport' })
    }),
  )
})
