// The owner's messages from outside goblin as turns, shared by the Telegram channel and Sources: a message becomes a
// turn in its Topic's Conversation (answered by goblin or a Persona) or a passive note there, through the one
// admission sequence, and how each turn ended is read back for the answer that goes out again.
import type { TextContent } from '@earendil-works/pi-ai'
import { type OwnTurnVia, PersonaAnswerData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { settledWithin } from '../chats/instance.ts'
import type { ReceiptInput } from '../chats/receipts.ts'
import { type AdmissionFlow, ChatOperations, Chats, Conversations } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { toAppError } from '../http/errors.ts'
import { askPersonas } from '../personas/ask.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { type KeptAttachments, messageContent } from '../pi/content.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import { askedChoice, askedText, cutOff } from '../pi/transcript.ts'

/**
 * One message from the owner into a goblin Topic: where, under which operation, from whom, its words, and what goblin
 * kept of its attachments.
 */
export type Turn = {
  readonly topic: number
  readonly operationId: string
  readonly author: string
  readonly text: string
  readonly kept?: KeptAttachments
}

/** A single-choice question an answer ended on, as buttons can ask it. */
type AskedChoice = {
  readonly prompt: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
}

/** How a turn ended: its words, and the question with buttons it asked when it stopped on one. */
export type Answer = { readonly text: string; readonly question?: AskedChoice }

/** Which turn an answer belongs to: its operation, the goblin chat it ran in and the Persona that answers it. */
export type ReplyRef = { readonly operationId: string; readonly chatId?: string; readonly personaId?: number }

/**
 * Where the owner's messages come from, as their turns record it: the operation's receipt, the flow it records, how a
 * Persona's ask came in, the kind of the passive note a message kept with no turn is written as, and the mark a turn's
 * content carries as the owner's own (`own`), which the web reads.
 */
export type TurnOrigin = {
  readonly receipt: Pick<ReceiptInput, 'kind' | 'origin'>
  readonly flow: Pick<AdmissionFlow, 'flow' | 'via'>
  readonly persona: Parameters<typeof askPersonas>[4]
  readonly note: `app.${string}`
  readonly own?: OwnTurnVia
}

/** A turn's content: its author and words, its mark as the owner's own when it is a turn, and what it brought. */
const turnContent = (origin: TurnOrigin, turn: Turn, asTurn: boolean) =>
  messageContent(turn.author, turn.text, {
    ...(asTurn && origin.own !== undefined ? { own: origin.own } : {}),
    ...(turn.kept === undefined ? {} : { kept: turn.kept }),
  })

/** Text blocks only: a Persona's ask carries no images, only the files' references. */
const isText = (block: { readonly type: string }): block is TextContent => block.type === 'text'

/** What is added to an answer that reached the output limit, as the web transcript's receipt says. */
const CUT_OFF = '(Cut off at the output limit. Ask it to continue.)'

/** A Pi call's failure as the programs take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

/** The session `operationId` went to in `chat`, admitting it there under `receipt` when nothing did yet. */
const turnSession = (chat: string, operationId: string, receipt: TurnOrigin['receipt']) =>
  Effect.gen(function* () {
    const operations = yield* ChatOperations
    const found = yield* operations.operation(chat, operationId)
    if (Option.isSome(found)) return found.value
    return (yield* operations.record(chat, operationId, receipt)).session
  })

/**
 * How goblin's turn in `chat` ended, as the place it came from should hear it: its final text, or what it asked the
 * owner when it stopped on a question (with its buttons when it was one single choice), and whether it was cut off;
 * none while it runs (it has not settled within 200 ms).
 */
const goblinAnswer = (chat: string, operationId: string, receipt: TurnOrigin['receipt']) =>
  Effect.gen(function* () {
    const session = yield* turnSession(chat, operationId, receipt)
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

/** How a turn from `origin` ended: the Persona's answer when one answers it, else goblin's in the chat it ran in. */
export const answerOf = (origin: TurnOrigin, reply: ReplyRef) =>
  Effect.gen(function* () {
    if (reply.personaId !== undefined) return yield* personaAnswer(reply.operationId, reply.personaId)
    // A reply tracked before routes ran in main.
    return yield* goblinAnswer(reply.chatId ?? (yield* Chats).primary, reply.operationId, origin.receipt)
  })

/**
 * The owner's message as a turn in its Topic's Conversation (Personal's while the Topic is archived or gone), through
 * the one admission sequence (`ChatOperations.send`): within the budget, admitted under the chat's lock, the session
 * put on the owner's model, then submitted. With `persona`, that Persona answers it there instead, while it is active;
 * goblin does when it is not. The same operation id is the same message. The chat it went to, and the Persona that
 * answers.
 */
export const submitTurn = (origin: TurnOrigin, turn: Turn, persona: number | undefined) =>
  Effect.gen(function* () {
    const home = yield* (yield* Conversations).routineHome(turn.topic)
    const content = turnContent(origin, turn, true)
    const active = persona !== undefined && (yield* (yield* Personas).active).some((each) => each.id === persona)
    if (active) {
      yield* askPersonas(
        { thread: home.chat, operationId: turn.operationId },
        [persona],
        'parallel',
        content.filter(isText),
        origin.persona,
      )
      return { chatId: home.chat, persona }
    }
    yield* (yield* ChatOperations).send({
      chat: home.chat,
      operationId: turn.operationId,
      receipt: origin.receipt,
      flow: { ...origin.flow, actor: 'owner', topic: home.topic },
      content,
    })
    return { chatId: home.chat }
  })

/** The owner's message kept in its Topic's Conversation as a passive note: the model reads it, no run starts. */
export const keepTurn = (origin: TurnOrigin, turn: Turn) =>
  Effect.gen(function* () {
    const home = yield* (yield* Conversations).routineHome(turn.topic)
    const now = yield* epochSeconds
    yield* (yield* ChatOperations).passiveWrite(home.chat, {
      requestId: turn.operationId,
      origin: origin.receipt.origin,
      entry: {
        kind: origin.note,
        data: { listen: true },
        model: [{ role: 'user', content: turnContent(origin, turn, false), timestamp: now * 1000 }],
      },
    })
  })
