// The Telegram channel's view of the agent (ADRs 0009, 0055): the Topics its routes send the owner's messages to, and
// how their turns end.
import { PersonaAnswerData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { epochSeconds } from '../clock.ts'
import { settledWithin } from '../chats/instance.ts'
import { ChatOperations, Chats, Conversations } from '../chats/service.ts'
import { toAppError } from '../http/errors.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import { askPersonas } from '../personas/ask.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { authoredContent } from '../pi/content.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import { askedChoice, askedText, cutOff } from '../pi/transcript.ts'
import type { AgentInput } from '../runtime/input.ts'
import type { Answer, ChannelPorts, ReplyRef, Turn } from './channel.ts'
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

/** What Telegram adds to an answer that reached the output limit, as the web transcript's receipt says. */
const CUT_OFF = '(Cut off at the output limit. Ask it to continue.)'

/** A Pi call's failure as the programs take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

/** The session `operationId` went to in `chat`, admitting it there when nothing did yet. */
const turnSession = (chat: string, operationId: string) =>
  Effect.gen(function* () {
    const operations = yield* ChatOperations
    const found = yield* operations.operation(chat, operationId)
    if (Option.isSome(found)) return found.value
    return (yield* operations.record(chat, operationId, { kind: 'telegram', origin: 'telegram' })).session
  })

/**
 * How goblin's turn in `chat` ended, as Telegram should hear it: its final text, or what it asked the owner when it
 * stopped on a question (with its buttons when it was one single choice), and whether it was cut off; none while it
 * runs (it has not settled within 200 ms).
 */
const goblinAnswer = (chat: string, operationId: string) =>
  Effect.gen(function* () {
    const session = yield* turnSession(chat, operationId)
    const settled = yield* settledWithin(session, operationId, 200)
    if (Option.isNone(settled)) return undefined
    const result = settled.value
    if (result.status === 'unanswered')
      return { text: `(No answer: ${result.reason ?? 'the turn ended without one'}.)` } satisfies Answer
    const entries = yield* (yield* PiSessions).messages(session).pipe(Effect.catchTag('PiFailure', piFailure))
    const final = result.text?.trim() ?? ''
    const question = final === '' ? askedChoice(entries) : undefined
    const text = final === '' ? askedText(entries) : final
    const answer = !cutOff(entries) ? text : text === '' ? CUT_OFF : `${text}\n\n${CUT_OFF}`
    return { text: answer, ...(question === undefined ? {} : { question }) } satisfies Answer
  })

const decodeAnswer = Schema.decodeUnknownOption(PersonaAnswerData)

/** How `persona`'s answer to `operationId` ended: its words once it answered, a line when it could not; none before. */
const personaAnswer = (operationId: string, persona: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* Invocations).get(operationId, persona)
    if (Option.isNone(found)) return undefined
    const invocation = found.value
    if (invocation.state === 'pending' || invocation.state === 'running') return undefined
    const none = { text: `(No answer: the Persona ${invocation.state === 'stopped' ? 'was stopped' : 'failed'}.)` }
    if (invocation.state !== 'answered' || invocation.answerEntry === undefined) return none satisfies Answer
    const session = yield* (yield* Chats).session(invocation.chat)
    const entries = yield* (yield* PiSessions).messages(session).pipe(Effect.catchTag('PiFailure', piFailure))
    const entry = entries.find((each) => Number(each.id) === invocation.answerEntry)
    const data = entry === undefined ? Option.none() : decodeAnswer(entry.data)
    return (Option.isSome(data) ? { text: data.value.text } : none) satisfies Answer
  })

/** How a Telegram turn ended: the Persona's answer when one answers it, else goblin's in the chat it ran in. */
const answerOf = (reply: ReplyRef) =>
  Effect.gen(function* () {
    if (reply.personaId !== undefined) return yield* personaAnswer(reply.operationId, reply.personaId)
    // A reply tracked before routes ran in main.
    return yield* goblinAnswer(reply.chatId ?? (yield* Chats).primary, reply.operationId)
  })

/** The flow a Telegram turn records: it came in through Telegram, from the owner. */
const FLOW = { flow: 'telegram', via: 'telegram', actor: 'owner' } as const

/**
 * The owner's Telegram message as a turn in its Topic's Conversation (Personal's while the Topic is archived or gone),
 * through the one admission sequence (`ChatOperations.send`): within the budget, admitted under the chat's lock, the
 * session put on the owner's model, then submitted. With `persona`, that Persona answers it there instead, while it
 * is active; goblin does when it is not. The same operation id is the same message. The chat it went to, and the
 * Persona that answers.
 */
const submitTurn = (turn: Turn, persona: number | undefined) =>
  Effect.gen(function* () {
    const home = yield* (yield* Conversations).routineHome(turn.topic)
    const content = authoredContent(turn.author, turn.text)
    const active = persona !== undefined && (yield* (yield* Personas).active).some((each) => each.id === persona)
    if (active) {
      yield* askPersonas({ thread: home.chat, operationId: turn.operationId }, [persona], 'parallel', content, {
        via: 'telegram',
      })
      return { chatId: home.chat, persona }
    }
    yield* (yield* ChatOperations).send({
      chat: home.chat,
      operationId: turn.operationId,
      receipt: { kind: 'telegram', origin: 'telegram' },
      flow: { ...FLOW, topic: home.topic },
      content,
    })
    return { chatId: home.chat }
  })

/** The owner's Telegram message kept in its Topic's Conversation as a passive note: the model reads it, no run starts. */
const keepTurn = (turn: Turn) =>
  Effect.gen(function* () {
    const home = yield* (yield* Conversations).routineHome(turn.topic)
    const now = yield* epochSeconds
    yield* (yield* ChatOperations).passiveWrite(home.chat, {
      requestId: turn.operationId,
      origin: 'telegram',
      entry: {
        kind: 'app.telegram',
        data: { listen: true },
        model: [{ role: 'user', content: authoredContent(turn.author, turn.text), timestamp: now * 1000 }],
      },
    })
  })

/**
 * The ports of the channel over the agent's services: the channel server's tools (`call`), the Topics, where an owner's
 * Telegram message becomes a turn within the budget on the owner's model (or a Persona's, or a note), and the end of
 * each turn.
 */
export const channelPorts = (call: ChannelCall) =>
  Effect.map(Effect.context<PortServices>(), (context): ChannelPorts => ({
    call,
    submit: (turn, persona) => Effect.provideContext(submitTurn(turn, persona), context),
    keep: (turn) => Effect.provideContext(keepTurn(turn), context),
    // The owner chose "New topic" (an offer's tap, or the default for new chats).
    topic: (title, operationId) => Effect.provideContext(topicFor(title, operationId, 'owner'), context),
    answer: (reply) => Effect.provideContext(answerOf(reply), context),
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
