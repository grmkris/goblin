import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach } from 'vitest'
import { telegramChannel } from '../src/channel/channel.ts'
import { enableTelegram, resubscribeEnded } from '../src/channel/program.ts'
import { Channel } from '../src/channel/service.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import type { Consumer, Subscription } from '../src/mcp/events/store.ts'
import { Events, McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import type { McpConnectionSnapshot, McpToolResult } from '../src/mcp/types.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const TOOLS = ['mygram_inbox_read', 'mygram_message_send', 'mygram_question_ask', 'mygram_chat_list']
const EVENTS = ['mygram.message.received', 'mygram.question.answered', 'mygram.chat.changed']

/** What the server answers a read of every chat: the inbox's end, or a refusal of a grant that reaches the DM only. */
type Reach = 'all' | 'dm'

/**
 * mysi with mygram behind it (its `mygram_` and `mygram.` spellings), offering Events, with a grant that reaches `reach`;
 * `refuseAll` refuses the Events of every chat even so. Records each grant and subscription.
 */
const world = (reach: Reach, refuseAll = false) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const sqlite = durable(db)
    const channel = yield* telegramChannel({ db: sqlite, telemetry: undefined, wake: () => undefined })
    const granted: string[] = []
    const subscribed: { readonly consumerId: string; readonly name: string; readonly args: string }[] = []
    const consumers = new Map<string, Consumer>()
    const statuses = new Map<string, string>()
    const snapshot: McpConnectionSnapshot = {
      config: { connectionId: 'mysi', endpoint: 'https://dev.mysi.lol/mcp' },
      capabilities: { events: {} },
      tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })),
      resources: [],
      resourceTemplates: [],
      prompts: [],
    }
    const services = Layer.mergeAll(
      Layer.succeed(Channel, channel),
      Layer.mock(McpServers, {
        tools: () => Effect.succeed(TOOLS.map((name) => ({ name, modelVisible: true, granted: false }))),
      }),
      Layer.mock(McpConnections, {
        snapshot: () => Effect.succeedSome(snapshot),
        connect: () => Effect.succeed(snapshot),
        callTool: (_connectionId, name, args) =>
          Effect.succeed<McpToolResult>(
            name === 'mygram_inbox_read' && args['chat'] === 'all' && reach === 'dm'
              ? {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        code: 'access_insufficient',
                        widenUrl: 'https://dev.mysi.lol/consent/widen?grant=g',
                      }),
                    },
                  ],
                }
              : { content: [], structuredContent: { messages: [], nextCursor: 'end' } },
          ),
      }),
      Layer.mock(McpGrants, {
        setTool: (_id, name) =>
          Effect.sync(() => {
            granted.push(name)
            return []
          }),
      }),
      Layer.mock(Events, {
        catalog: () => Effect.succeed(EVENTS.map((name) => ({ name, inputSchema: {}, delivery: ['poll', 'webhook'] }))),
        grant: () => Effect.void,
        subscribe: (input) =>
          Effect.gen(function* () {
            const args = JSON.stringify(input.arguments)
            if (refuseAll && args !== '{}')
              return yield* new UpstreamMcp({ connectionId: input.connectionId, reason: 'remote-rpc' })
            subscribed.push({ consumerId: input.consumerId, name: input.name, args })
            const subscriptionId = `${input.name}:${args}`
            statuses.set(subscriptionId, 'active')
            // SAFETY: the program reads only a binding's subscription, consumer id and revision.
            consumers.set(input.consumerId, {
              consumerId: input.consumerId,
              revision: input.revision,
              subscriptionId,
            } as Consumer)
            return { subscriptionId, status: 'active' }
          }),
        unsubscribe: () => Effect.succeed({ retired: true, remoteCleanup: true }),
        activeConsumer: (consumerId) => Effect.succeed(Option.fromUndefinedOr(consumers.get(consumerId))),
        subscription: (id) =>
          Effect.succeed(
            // SAFETY: the program reads only a subscription's status.
            Option.map(Option.fromUndefinedOr(statuses.get(id)), (status) => ({ id, status }) as Subscription),
          ),
      }),
    )
    return { services, channel, granted, subscribed, statuses }
  })

describe('turning the Telegram channel on (unit)', () => {
  it.effect('grants every channel tool and subscribes every chat when the grant reaches all of them', () =>
    Effect.gen(function* () {
      const { services, channel, granted, subscribed } = yield* world('all')
      const status = yield* enableTelegram('mysi', async () => undefined).pipe(Effect.provide(services))
      expect(status).toMatchObject({ connectionId: 'mysi', reach: 'all', newChats: 'ask' })
      expect(granted).toEqual(TOOLS)
      expect(subscribed.map(({ name, args }) => [name, args])).toEqual(EVENTS.map((name) => [name, '{"chat":"all"}']))
      expect((yield* channel.status)?.widenUrl).toBeUndefined()
    }),
  )

  it.effect('subscribes the DM alone and keeps the widen link when the grant reaches only the DM', () =>
    Effect.gen(function* () {
      const { services, subscribed } = yield* world('dm')
      const status = yield* enableTelegram('mysi', async () => undefined).pipe(Effect.provide(services))
      expect(status).toMatchObject({ reach: 'dm', widenUrl: 'https://dev.mysi.lol/consent/widen?grant=g' })
      expect(subscribed.map(({ args }) => args)).toEqual(['{}', '{}', '{}'])
    }),
  )

  it.effect('falls back to the DM when the server will not deliver the Events of every chat', () =>
    Effect.gen(function* () {
      const { services, subscribed } = yield* world('all', true)
      const status = yield* enableTelegram('mysi', async () => undefined).pipe(Effect.provide(services))
      expect(status).toMatchObject({ reach: 'dm' })
      expect(subscribed.map(({ args }) => args)).toEqual(['{}', '{}', '{}'])
    }),
  )

  it.effect('subscribes again once the server ended a subscription, and not while all are live', () =>
    Effect.gen(function* () {
      const { services, subscribed, statuses } = yield* world('all')
      yield* enableTelegram('mysi', async () => undefined).pipe(Effect.provide(services))
      yield* resubscribeEnded.pipe(Effect.provide(services))
      expect(subscribed).toHaveLength(3)
      statuses.set('mygram.message.received:{"chat":"all"}', 'terminated')
      yield* resubscribeEnded.pipe(Effect.provide(services))
      expect(subscribed).toHaveLength(6)
    }),
  )
})
