// goblin's offers about new Telegram chats (ADR 0055): a chat or forum topic it sees for the first time waits for the
// owner, who is asked once in the DM with buttons; the default for new chats can route it at once instead. The owner's
// tap comes back as an answer entry carrying the question's id, and sets the route.
import { PERSONAL_TOPIC, TELEGRAM_DM } from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { AppError } from '../http/errors.ts'
import { topicOperation } from './places.ts'
import { type RouteChoice, type RouteRow, openOffer, routeRow } from './routes.ts'
import { channelStatus } from './store.ts'
import type { ChannelCall, TelegramRefused } from './tools.ts'

/** A chat or topic by its handle and thread. */
export type ChatKey = { readonly chat: string; readonly thread: number }

/** What offering needs: the database, the server's tools, a Topic for "New topic", and a route set and delivered. */
export type Offering = {
  readonly db: DrizzleSqliteDODatabase
  readonly call: ChannelCall
  readonly topic: (name: string, operationId: string) => Effect.Effect<number, AppError>
  readonly routeTo: (key: ChatKey, choice: RouteChoice, now: number) => Effect.Effect<void, AppError | TelegramRefused>
}

/** The buttons of an offer: a new Topic, the chat's or Personal, or nothing. */
type OfferChoice = 'topic' | 'personal' | 'inherit' | 'ignore'
const CHOICES: ReadonlySet<string> = new Set(['topic', 'personal', 'inherit', 'ignore'])
const isChoice = (value: string): value is OfferChoice => CHOICES.has(value)

/** Plain text as Telegram HTML. */
const html = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A title as a button shows it: at most 40 characters. */
const short = (title: string) => (title.length > 40 ? `${title.slice(0, 39)}…` : title)

/** What goblin asks about `row` in the DM, and its buttons. */
export function offerQuestion(db: DrizzleSqliteDODatabase, row: RouteRow) {
  if (row.thread === 0)
    return {
      question: `I was added to <b>${html(row.title)}</b>. Where should it go?`,
      options: [
        { id: 'topic', label: `New topic #${short(row.title)}` },
        { id: 'personal', label: 'Personal' },
        { id: 'ignore', label: 'Ignore' },
      ],
    }
  const chat = row.chat === TELEGRAM_DM ? 'our chat' : (routeRow(db, row.chat, 0)?.title ?? 'a group')
  return {
    question: `A new topic <b>${html(row.title)}</b> started in <b>${html(chat)}</b>. Where should it go?`,
    options: [
      { id: 'topic', label: `New topic #${short(row.title)}` },
      { id: 'inherit', label: 'Same as the chat' },
      { id: 'ignore', label: 'Ignore' },
    ],
  }
}

const Asked = Schema.Struct({ id: Schema.optional(Schema.String) })
const decodeAsked = Schema.decodeUnknownOption(Asked)

/** Asks the owner about `row` in the DM, once (the same operation finds the same question); remembers its id. */
const ask = (offering: Offering, row: RouteRow) =>
  Effect.gen(function* () {
    const { question, options } = offerQuestion(offering.db, row)
    const asked = yield* offering.call('ask', {
      operationId: `telegram-offer:${row.chat}:${String(row.thread)}`,
      question,
      mode: 'choice',
      options,
      chat: TELEGRAM_DM,
      waitMs: 0,
    })
    const id = Option.flatMap(decodeAsked(asked), ({ id: found }) => Option.fromUndefinedOr(found))
    if (Option.isSome(id)) openOffer(offering.db, row, id.value)
  })

/** Whether goblin should ask about `row` or apply the default: never asked, the bot in its chat, and no route yet. */
function waiting(db: DrizzleSqliteDODatabase, row: RouteRow): boolean {
  if (row.offer !== null) return false
  const chat = row.thread === 0 ? row : routeRow(db, row.chat, 0)
  if (chat === undefined || chat.status === 'paused' || chat.status === 'left') return false
  return row.thread === 0 ? row.status === 'pending' : row.mode === null && chat.status !== 'pending'
}

/**
 * A chat or topic goblin sees for the first time: with the default `ask`, the owner is asked in the DM; with `topic`,
 * it gets a new Topic named after it; with `personal`, a chat goes to Personal and a topic follows its chat. Nothing
 * for one that is not waiting.
 */
export const discover = (offering: Offering, key: ChatKey, now: number) =>
  Effect.gen(function* () {
    const { db } = offering
    const row = routeRow(db, key.chat, key.thread)
    if (row === undefined || !waiting(db, row)) return
    const newChats = channelStatus(db)?.newChats ?? 'ask'
    if (newChats === 'ask') return yield* ask(offering, row)
    if (newChats === 'personal') {
      if (key.thread === 0) yield* offering.routeTo(key, { mode: 'answer', topic: PERSONAL_TOPIC }, now)
      return
    }
    const topic = yield* offering.topic(row.title, topicOperation(key.chat, key.thread))
    yield* offering.routeTo(key, { mode: 'answer', topic }, now)
  })

/**
 * mygram's display line for a tap, `Question <id>: <name> tapped "<choice>" (<label>).`: display text, not a contract,
 * read only for a question goblin did not keep the buttons of.
 */
const TAPPED = /tapped ("(?:[^"\\]|\\.)*") \((.*)\)\.$/su
const Quoted = Schema.fromJsonString(Schema.String)

/** The choice and label of a tap, as mygram's answer entry words it; none for other words. */
export function tapOf(text: string): { readonly choice: string; readonly label: string } | undefined {
  const [, quoted = '', label = ''] = TAPPED.exec(text.trim()) ?? []
  const choice = Option.getOrUndefined(Schema.decodeUnknownOption(Quoted)(quoted))
  return choice === undefined ? undefined : { choice, label }
}

const QuestionState = Schema.Struct({
  question: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      choice: Schema.optional(Schema.String),
      answer: Schema.optional(Schema.String),
    }),
  ),
})
const decodeQuestion = Schema.decodeUnknownOption(QuestionState)

/** How the owner answered a question, as the server keeps it: the pressed option's id, or their reply in text mode. */
export type Answered = { readonly choice?: string; readonly answer?: string }

/**
 * How the owner answered question `questionId`, read from the server (`inbox_read { questionId }`), not from the
 * answer entry's words, which are display text; none while it is open.
 */
export const answeredQuestion = (call: ChannelCall, questionId: string) =>
  Effect.map(call('inbox', { questionId, limit: 1 }), (read): Answered | undefined =>
    Option.getOrUndefined(
      Option.flatMap(decodeQuestion(read), ({ question }) =>
        question?.status === 'answered'
          ? Option.some({
              ...(question.choice === undefined ? {} : { choice: question.choice }),
              ...(question.answer === undefined ? {} : { answer: question.answer }),
            })
          : Option.none(),
      ),
    ),
  )

/** An offer's choice in the owner's typed words, when they name a button ("Personal"). */
function typedChoice(db: DrizzleSqliteDODatabase, row: RouteRow, text: string): OfferChoice | undefined {
  const words = text.trim().toLowerCase()
  const found = offerQuestion(db, row).options.find(
    (option) => option.id === words || option.label.toLowerCase() === words,
  )
  return found === undefined || !isChoice(found.id) ? undefined : found.id
}

/**
 * The owner answered goblin's offer about `row` (`questionId`): the choice the server keeps for the question first (the
 * button they pressed), else their typed words naming a button; the route it names is set and what waited is
 * delivered. An answer goblin cannot read leaves the offer open. No turn starts.
 */
export const resolveOffer = (
  offering: Offering,
  row: RouteRow,
  answer: { readonly text: string; readonly questionId: string },
  now: number,
) =>
  Effect.gen(function* () {
    const answered = yield* answeredQuestion(offering.call, answer.questionId)
    const pressed = answered?.choice
    const choice =
      pressed !== undefined && isChoice(pressed)
        ? pressed
        : typedChoice(offering.db, row, answered?.answer ?? answer.text)
    if (choice === undefined) return
    const key = { chat: row.chat, thread: row.thread }
    if (choice === 'topic') {
      const topic = yield* offering.topic(row.title, topicOperation(row.chat, row.thread))
      return yield* offering.routeTo(key, { mode: 'answer', topic }, now)
    }
    if (choice === 'personal') return yield* offering.routeTo(key, { mode: 'answer', topic: PERSONAL_TOPIC }, now)
    yield* offering.routeTo(key, { mode: choice }, now)
  })
