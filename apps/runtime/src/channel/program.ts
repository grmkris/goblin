// Turning the Telegram channel on and off (ADRs 0009, 0055): the owner's choice of a connection grants the channel's
// tools and subscribes its Events, every chat the grant reaches (`{ chat: 'all' }`) or the DM alone when it reaches no
// further. A subscription the server ended (as a widened grant ends them) is made again by the next pull.
import {
  TELEGRAM_EVENTS,
  TELEGRAM_OPTIONAL_EVENTS,
  type TelegramReach,
  telegramEvent,
  telegramTools,
} from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import { InvalidInput, attempt } from '../http/errors.ts'
import { TELEGRAM_INBOX } from '../mcp/events/consumers.ts'
import type { Consumer } from '../mcp/events/store.ts'
import { offersEvents } from '../mcp/connections/remote.ts'
import { Events, McpConnections, McpGrants, McpServers } from '../mcp/service.ts'
import { Channel } from './service.ts'
import { type ChannelCall, channelTool } from './tools.ts'

/** Every Event the channel may take: the two it needs, then the ones it uses once the server offers them. */
const CHANNEL_EVENTS = [...TELEGRAM_EVENTS, ...TELEGRAM_OPTIONAL_EVENTS] as const

/** The consumer of one Telegram Event: keyed by mygram's own event name, whichever spelling the server uses. */
const consumerOf = (connectionId: string | undefined, event: string) => `telegram:${connectionId}:${event}`

/** How a read of every chat is asked, and the Events' arguments for every chat. */
const ALL = { chat: 'all' } as const

/**
 * The Telegram Events as `connectionId` names them (mygram's own, or mysi's `mygram.` ones), from the Events it lists:
 * the ones the channel needs (InvalidInput naming one it does not offer), then the ones it uses when offered.
 */
const telegramEvents = (events: typeof Events.Service, connectionId: string) =>
  Effect.gen(function* () {
    const offered = new Set((yield* events.catalog(connectionId)).map(({ name }) => name))
    const named: { readonly event: string; readonly name: string }[] = []
    for (const event of TELEGRAM_EVENTS) {
      const name = telegramEvent(offered, event)
      if (name === undefined) return yield* new InvalidInput({ reason: `${connectionId} does not offer ${event}` })
      named.push({ event, name })
    }
    for (const event of TELEGRAM_OPTIONAL_EVENTS) {
      const name = telegramEvent(offered, event)
      if (name !== undefined) named.push({ event, name })
    }
    return named
  })

/** A widen URL the owner may follow: https only, at most 2048 characters; none otherwise. */
const widenLink = (url: string | undefined): { readonly widenUrl?: string } => {
  if (url === undefined || url.length > 2048) return {}
  try {
    return new URL(url).protocol === 'https:' ? { widenUrl: url } : {}
  } catch {
    // expected: a URL that does not parse is not offered to the owner.
    return {}
  }
}

type Reach = { readonly reach: TelegramReach; readonly widenUrl?: string }

/**
 * How far the grant reaches: a read of every chat answers `all`; a refusal (or an RPC error, from a server that does
 * not know `chat`) answers `dm`, with the URL that widens the grant when the server named one. A transport failure
 * fails.
 */
const reachOf = (call: ChannelCall) =>
  call('inbox', { ...ALL, limit: 1 }).pipe(
    Effect.as<Reach>({ reach: 'all' }),
    Effect.catchTag('TelegramRefused', (refused) =>
      Effect.succeed<Reach>({
        reach: 'dm',
        ...(refused.code === 'access_insufficient' ? widenLink(refused.widenUrl) : {}),
      }),
    ),
    Effect.catchTag('UpstreamMcp', (error) =>
      // expected: a server that answers the read of every chat with an RPC error (an older mygram that does not know
      // `chat`) still carries the DM; any other failure of the server fails the switch.
      error.reason === 'remote-rpc' ? Effect.succeed<Reach>({ reach: 'dm' }) : Effect.fail(error),
    ),
  )

/** Subscribes each named Event for the channel's consumer at `revision` with `args`. */
const subscribeEach = (
  events: typeof Events.Service,
  connectionId: string,
  named: readonly { readonly event: string; readonly name: string }[],
  args: Record<string, unknown>,
  revision: number,
) =>
  Effect.forEach(
    named,
    ({ event, name }) =>
      Effect.andThen(
        events.grant(connectionId, name, args, true),
        events.subscribe({
          consumerId: consumerOf(connectionId, event),
          revision,
          connectionId,
          name,
          arguments: args,
          handlerKey: TELEGRAM_INBOX,
        }),
      ),
    { discard: true },
  )

/** Ends the consumers that were bound before this subscription; each one bound now stays. */
const retire = (events: typeof Events.Service, bindings: readonly Option.Option<Consumer>[]) =>
  Effect.forEach(
    bindings,
    (binding) => (Option.isSome(binding) ? Effect.asVoid(events.unsubscribe(binding.value)) : Effect.void),
    { discard: true },
  )

/**
 * Grants `connectionId`'s channel tools and subscribes its Events for every chat the grant reaches: with `{ chat: 'all' }`
 * when it reaches all of them, falling back to the DM alone when the server refuses that. The reach it settled on.
 */
const subscribeTelegram = (connectionId: string) =>
  Effect.gen(function* () {
    const connections = yield* McpConnections
    const events = yield* Events
    const channel = yield* Channel
    const tools = (yield* McpServers.use((servers) => servers.tools(connectionId, true))).map(({ name }) => name)
    const snapshot = yield* connections.snapshot(connectionId)
    const names = telegramTools(tools)
    if (names === undefined)
      return yield* new InvalidInput({
        reason: `${connectionId} does not offer Telegram's inbox_read and message_send`,
      })
    if (Option.isNone(snapshot) || !offersEvents(snapshot.value))
      return yield* new InvalidInput({ reason: `${connectionId} does not offer Events` })
    const named = yield* telegramEvents(events, connectionId)
    const grants = yield* McpGrants
    for (const tool of Object.values(names).filter((name) => tools.includes(name)))
      yield* grants.setTool(connectionId, tool, true)
    const call = channelTool(connections, connectionId)
    const probed = yield* reachOf(call)
    const revision = yield* Clock.currentTimeMillis
    const previous: Option.Option<Consumer>[] = []
    for (const event of CHANNEL_EVENTS) {
      const current = (yield* channel.status)?.connectionId ?? connectionId
      previous.push(yield* events.activeConsumer(consumerOf(current, event)))
    }
    const reach =
      probed.reach === 'dm'
        ? probed
        : yield* subscribeEach(events, connectionId, named, ALL, revision).pipe(
            Effect.as(probed),
            // expected: the server reads every chat but will not deliver their Events; the DM's carry the channel.
            Effect.catch(() =>
              Effect.gen(function* () {
                for (const { event } of named)
                  // expected: a revision the refusal left unbound has nothing to end.
                  yield* Effect.ignore(events.unsubscribe({ consumerId: consumerOf(connectionId, event), revision }))
                return { reach: 'dm' } satisfies Reach
              }),
            ),
          )
    if (reach.reach === 'dm') yield* subscribeEach(events, connectionId, named, {}, revision + 1)
    return { reach, previous, call, events }
  })

/**
 * The owner's choice: `connectionId` carries Telegram. Grants only the channel's tools, subscribes its Events (every
 * chat the grant reaches), and fences the inbox cursor after the leases confirm: a new connection starts at the end of
 * its inbox, so its history is not taken for new messages. The consumers the channel had before end after.
 */
export const enableTelegram = Effect.fn('channel.enable')(function* (
  connectionId: string,
  wake: () => Promise<unknown>,
) {
  const channel = yield* Channel
  const { reach, previous, call, events } = yield* subscribeTelegram(connectionId)
  const cursor = yield* channel.startCursor(connectionId, call, reach.reach === 'all' ? ALL : {})
  const status = yield* channel.enableEvents(connectionId, cursor, yield* epochSeconds, reach)
  yield* retire(events, previous)
  yield* attempt(wake)
  return status
})

/**
 * Subscribes the channel's Events again when the server ended one (a widened grant ends them all): the same connection,
 * from its stored cursor, with the reach the grant has now. Nothing while every subscription is live.
 */
export const resubscribeEnded = Effect.gen(function* () {
  const channel = yield* Channel
  const events = yield* Events
  const status = yield* channel.status
  if (status === null) return
  let ended = false
  for (const event of TELEGRAM_EVENTS) {
    const binding = yield* events.activeConsumer(consumerOf(status.connectionId, event))
    const subscription = Option.isNone(binding)
      ? Option.none()
      : yield* events.subscription(binding.value.subscriptionId)
    if (Option.isNone(subscription) || subscription.value.status === 'terminated') ended = true
  }
  if (!ended) return
  const { reach, previous } = yield* subscribeTelegram(status.connectionId)
  yield* channel.setReach(reach)
  yield* channel.chatsChanged
  yield* retire(events, previous)
})

/** Turns the channel off: every Telegram consumer ends, and the answers still to send are dropped. */
export const disableTelegram = Effect.gen(function* () {
  const channel = yield* Channel
  const events = yield* Events
  const status = yield* channel.status
  for (const event of CHANNEL_EVENTS) {
    const binding = yield* events.activeConsumer(consumerOf(status?.connectionId, event))
    if (Option.isSome(binding)) yield* events.unsubscribe(binding.value)
  }
  yield* channel.disable
  return null
})
