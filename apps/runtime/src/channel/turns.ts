// The Telegram channel's view of the agent (ADRs 0009, 0055): the Topics its routes send the owner's messages to, and
// how their turns end, through the turns Sources share (sources/turns.ts).
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { ChatOperations, Chats, Conversations } from '../chats/service.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import type { Invocations, Personas } from '../personas/service.ts'
import type { PiSessions } from '../pi/sessions.ts'
import type { AgentInput } from '../runtime/input.ts'
import { type TurnOrigin, answerOf, keepTurn, submitTurn } from '../sources/turns.ts'
import type { ChannelPorts } from './channel.ts'
import { topicFor } from './places.ts'
import { Channel } from './service.ts'
import { type ChannelCall, channelTool } from './tools.ts'

/** What making a Topic for a route reads: the Topics, their receipts and flows, and what a setup may hold. */
type TopicServices = Effect.Services<ReturnType<typeof topicFor>>

/** What the ports' programs read, captured once when the ports are made. */
type PortServices =
  | Chats
  | ChatOperations
  | Conversations
  | PiSessions
  | Personas
  | Invocations
  | AgentInput
  | TopicServices

/** A Telegram turn as it is recorded: its receipt, its flow, a Persona's ask, and a kept message's note. */
const TELEGRAM: TurnOrigin = {
  receipt: { kind: 'telegram', origin: 'telegram' },
  flow: { flow: 'telegram', via: 'telegram' },
  persona: { via: 'telegram' },
  note: 'app.telegram',
}

/**
 * The ports of the channel over the agent's services: the channel server's tools (`call`), the Topics, where an owner's
 * Telegram message becomes a turn within the budget on the owner's model (or a Persona's, or a note), and the end of
 * each turn.
 */
export const channelPorts = (call: ChannelCall) =>
  Effect.map(Effect.context<PortServices>(), (context): ChannelPorts => ({
    call,
    submit: (turn, persona) => Effect.provideContext(submitTurn(TELEGRAM, turn, persona), context),
    keep: (turn) => Effect.provideContext(keepTurn(TELEGRAM, turn), context),
    // The owner chose "New topic" (an offer's tap, or the default for new chats).
    topic: (title, operationId) => Effect.provideContext(topicFor(title, operationId, 'owner'), context),
    answer: (reply) => Effect.provideContext(answerOf(TELEGRAM, reply), context),
  }))

/**
 * Runs `work` on the Telegram channel and its ports while the channel is on and resident authority is current; none
 * when the channel is off.
 */
export const onChannel = <A, E, R>(
  work: (channel: typeof Channel.Service, ports: ChannelPorts) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* requireResident
    const channel = yield* Channel
    const status = yield* channel.status
    if (status === null) return Option.none<A>()
    const ports = yield* channelPorts(channelTool(yield* McpConnections, status.connectionId))
    return Option.some(yield* work(channel, ports))
  })
