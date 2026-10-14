// The Telegram channel (ADRs 0009, 0055): one MCP connection the owner chose, mygram's bound to the agent's own bot
// (directly, or through mysi), carries Telegram both ways. The server's Events wake the agent (channel/program.ts); it
// then reads the inbox from its cursor, every chat the grant reaches in one
// stream, and routes each new message from the owner by its chat and forum topic (channel/routes.ts): a turn in the
// Topic of its route answered by goblin or a Persona, a note kept there, nothing, or held while the chat waits for the
// owner's choice. Each answer goes back to the chat and topic its message came from. The rows are channel/store.ts and
// channel/routes.ts; the server's tools are channel/tools.ts.
import { type ChannelStatus, TELEGRAM_AUTHOR, TELEGRAM_DM, TelegramChatHandle } from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { type AppError, InvalidInput, toAppError } from '../http/errors.ts'
import { writeLine } from '../observability/logger.ts'
import { type LedgerInput, deliverReady, turnLedger } from '../sources/delivery.ts'
import { deliverHeld } from '../sources/held.ts'
import { chunks, operationIdOf } from '../sources/text.ts'
import type { Answer, ReplyRef, Turn } from '../sources/turns.ts'
import { failureAttributes, outcomeOf } from '../telemetry/attributes.ts'
import { expectedFailure } from '../telemetry/safety.ts'
import { type ChatKey, type Offering, answeredQuestion, discover, resolveOffer, tapOf } from './offers.ts'
import {
  type Held,
  type RouteChoice,
  effectiveRoute,
  heldOf,
  hold,
  offerOf,
  release,
  routeRow,
  seeChat,
  setPresence,
  setRoute,
  takeDropped,
} from './routes.ts'
import { Channel } from './service.ts'
import {
  type AskedButtons,
  type ReplyTarget,
  carries,
  channelStatus,
  checkpoint,
  disableChannel,
  enableEvents,
  inboxCursor,
  askedButtons,
  markDelivered,
  pendingReplies,
  markEnded,
  markSyncDue,
  setNewChats,
  setReach,
  storedCursor,
  takeSyncDue,
  telegramRevision,
  trackReply,
} from './store.ts'
import { syncChats } from './sync.ts'
import { type ChannelCall, type TelegramRefused, refusedAsUpstream } from './tools.ts'

/** Pages of 100 read at most per pull. */
const MAX_PAGES = 50
/** Pages of 100 read at most to find the end of the inbox when the channel is turned on. */
const MAX_HISTORY_PAGES = 200
/** Telegram's limit is 4096 characters of HTML; plain text is cut well below it so escaping cannot push it over. */
const CHUNK = 3500

/**
 * One inbox entry, as much of it as the channel reads: its chat (`dm` when absent) and forum topic, how it reached the
 * bot, the question it answers, its words and attachments. Text, titles and names are untrusted data.
 */
const Message = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  chat: Schema.optional(Schema.NullOr(Schema.String)),
  threadId: Schema.optional(Schema.NullOr(Schema.Number)),
  trigger: Schema.optional(Schema.NullOr(Schema.String)),
  questionId: Schema.optional(Schema.NullOr(Schema.String)),
  direction: Schema.optional(Schema.String),
  delivery: Schema.optional(Schema.String),
  media: Schema.optional(Schema.Array(Schema.Struct({ kind: Schema.String, name: Schema.String }))),
})
type Message = typeof Message.Type
const Inbox = Schema.Struct({ messages: Schema.Array(Message), nextCursor: Schema.String })
const isHandle = Schema.is(TelegramChatHandle)
/** What `question_ask` answers: the question's id, once the server admitted it. */
const decodeAsked = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.optional(Schema.String) }))

/** What the channel needs from the agent: the channel server's tools, the Topics, and the end of a turn. */
export interface ChannelPorts {
  /** A tool of the channel server; its structured result. */
  readonly call: ChannelCall
  /**
   * The owner's Telegram message as a turn in the Topic (idempotent by operation id), answered by `persona` while it is
   * active, else by goblin: the chat it went to and the Persona that answers.
   */
  readonly submit: (
    turn: Turn,
    persona?: number,
  ) => Effect.Effect<{ readonly chatId: string; readonly persona?: number }, AppError>
  /** The owner's Telegram message kept in the Topic with no turn (idempotent by operation id). */
  readonly keep: (turn: Turn) => Effect.Effect<void, AppError>
  /** The Topic a route's "New topic" makes for a chat or topic named `title` (idempotent by operation id). */
  readonly topic: (title: string, operationId: string) => Effect.Effect<number, AppError>
  /** How a turn ended, once it has; undefined while it runs. */
  readonly answer: (reply: ReplyRef) => Effect.Effect<Answer | undefined, AppError>
}

/** One answer's delivery to Telegram: the turn's operation id, how many messages it took, and why it failed if it did. */
export type DeliveredReply = { readonly operationId: string; readonly pieces: number; readonly errorType?: string }

/** Plain text as Telegram HTML. */
export const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** An inbox entry as the words a Topic receives: its text, then its attachments by kind and name (untrusted names). */
const messageText = (message: Message) =>
  [message.text, ...(message.media ?? []).map((media) => `[attachment: ${media.kind} ${JSON.stringify(media.name)}]`)]
    .filter((part) => part !== '')
    .join('\n')

/** One line when a pull or a delivery fails: the alarm's step and the error's type, never message content. */
export function reportChannelFailure(step: 'pull' | 'replies' | 'resubscribe' | 'offer', error: unknown): void {
  const tag = outcomeOf(error)
  writeLine(expectedFailure(tag) ? 'info' : 'warn', { event: 'wake', task: `channel.${step}`, 'error.type': tag })
}

/** The inbox read from `cursor`: none (or an empty one) is its start, which the inbox tool reads with no cursor. */
const after = (cursor: string | undefined) => (cursor === undefined || cursor === '' ? {} : { cursor })

/** Which chats an inbox read covers: every chat the grant reaches in one stream, or the DM alone. */
const chatsRead = (status: ChannelStatus) => (status?.reach === 'all' ? { chat: 'all' } : {})

const decodeInbox = (value: unknown) => Schema.decodeUnknownEffect(Inbox)(value).pipe(Effect.mapError(toAppError))

/** Reads the inbox from its start to its end, a page of 100 at a time: the cursor after the last message. */
const readToEnd = Effect.fn('Channel.readToEnd')(function* (call: ChannelCall, chats: { readonly chat?: string }) {
  let cursor: string | undefined
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const inbox = yield* decodeInbox(yield* call('inbox', { ...chats, ...after(cursor), limit: 100 }))
    cursor = inbox.nextCursor
    if (inbox.messages.length === 0) return cursor
  }
  return yield* new InvalidInput({ reason: 'the inbox is too long to start from its end' })
})

/** What the channel is made over: the agent's database and its run ledger. */
export type ChannelInput = LedgerInput & {
  /** Asks the agent to send the answers that are ready (a schedule of its own). */
  readonly wake: () => void
}

/** One message in, one answer out, in the run ledger (ADR 0024), attributed to Telegram (sources/delivery.ts). */
const recorder = (input: ChannelInput) => turnLedger(input, 'telegram')
type Recorder = ReturnType<typeof recorder>

/** Where to start reading `connectionId`'s inbox: the stored cursor when it already carries the channel, else its end. */
const startCursor = (
  db: DrizzleSqliteDODatabase,
  connectionId: string,
  call: ChannelCall,
  chats: { readonly chat?: string },
) =>
  Effect.suspend(() =>
    channelStatus(db)?.connectionId === connectionId ? Effect.sync(() => storedCursor(db)) : readToEnd(call, chats),
  )

/** Where a message came from: its chat (`dm` when absent) and forum topic (0 when none). */
const placeOf = (message: Message) => ({ chat: message.chat ?? TELEGRAM_DM, thread: message.threadId ?? 0 })

/** Who a message is from in a Topic: Telegram, and the chat and topic's titles for anything but the DM itself. */
function authorOf(db: DrizzleSqliteDODatabase, chat: string, thread: number): string {
  const chatTitle = chat === TELEGRAM_DM ? undefined : routeRow(db, chat, 0)?.title
  const topicTitle = thread === 0 ? undefined : routeRow(db, chat, thread)?.title
  const where = [chatTitle, topicTitle].filter((title) => title !== undefined && title !== '').join(' / ')
  return where === '' ? TELEGRAM_AUTHOR : `${TELEGRAM_AUTHOR} · ${where}`
}

/**
 * Makes sure goblin knows the chat and topic a message came from: one it had not seen is recorded with what it can tell
 * of it until the server's lists say more, and a chat the bot was out of is in it again.
 */
const firstSight = (db: DrizzleSqliteDODatabase, chat: string, thread: number, now: number): ChatKey[] => {
  const known = routeRow(db, chat, 0)
  const dm = chat === TELEGRAM_DM
  const kind = known?.kind ?? (dm ? 'private' : 'group')
  const created: ChatKey[] = []
  if (known === undefined) {
    seeChat(db, { chat, thread: 0, title: dm ? 'Telegram' : 'Telegram group', kind }, now)
    created.push({ chat, thread: 0 })
  } else if (known.status === 'paused' || known.status === 'left') setPresence(db, chat, 'active', now)
  if (thread > 0 && routeRow(db, chat, thread) === undefined) {
    seeChat(db, { chat, thread, title: `Topic ${String(thread)}`, kind }, now)
    created.push({ chat, thread })
  }
  return created
}

/** Whether goblin has never seen `chat`, or its forum topic `thread`. */
const unseen = (db: DrizzleSqliteDODatabase, chat: string, thread: number) =>
  routeRow(db, chat, 0) === undefined || (thread > 0 && routeRow(db, chat, thread) === undefined)

/**
 * The channel's routing over its rows and ports: each message from the owner goes where its chat's (or topic's) route
 * says, and each answer goes back where its message came from.
 */
const router = (input: ChannelInput, record: Recorder, ports: ChannelPorts) => {
  const { db } = input

  /** One message (new, or held until now) to where its route says; `note` goes before its words. */
  const route = (held: Held, now: number, note = '') =>
    Effect.gen(function* () {
      const { chat, thread } = held
      const effective = effectiveRoute(db, chat, thread)
      if (effective.mode === 'hold') return yield* Effect.sync(() => hold(db, held, now))
      if (effective.mode === 'ignore') return
      const operationId = operationIdOf('telegram', held.entryId)
      const turn = {
        topic: effective.topic,
        operationId,
        author: authorOf(db, chat, thread),
        text: `${note}${held.text}`,
      }
      if (effective.mode === 'listen') return yield* ports.keep(turn)
      const startedAt = yield* Clock.currentTimeMillis
      const attributes = { [RunAttribute.channelMessage]: held.entryId }
      const { chatId, persona } = yield* ports.submit(turn, effective.persona).pipe(
        Effect.tapError((error) =>
          record('channel.received', { operationId, chatId: undefined }, startedAt, {
            ...attributes,
            ...failureAttributes(error),
          }),
        ),
      )
      yield* record('channel.received', { operationId, chatId }, startedAt, attributes)
      const target: ReplyTarget = {
        chatId,
        tgChat: chat,
        tgThread: thread,
        ...(persona === undefined ? {} : { personaId: persona }),
      }
      if (trackReply(db, operationId, now, target)) input.wake()
    })

  /**
   * What `chat` held while it waited, delivered in order once each message's chat or topic has a route; how many were
   * dropped goes before the first.
   */
  const releaseHeld = (chat: string, now: number) =>
    Effect.gen(function* () {
      const ready = heldOf(db, chat).filter((held) => effectiveRoute(db, held.chat, held.thread).mode !== 'hold')
      if (ready.length === 0) return
      const dropped = effectiveRoute(db, chat, 0).mode === 'hold' ? 0 : takeDropped(db, chat)
      yield* deliverHeld(
        ready,
        dropped,
        'chat',
        (held, note) => route(held, now, note),
        (held) => release(db, held.entryId),
      )
    })

  /** Sets `key`'s route as the owner chose it (an offer's answer, the default for new chats) and delivers what waited. */
  const routeTo = (key: ChatKey, choice: RouteChoice, now: number) =>
    Effect.gen(function* () {
      if (setRoute(db, key, choice, 'owner', now) === undefined) return
      if (choice.mode !== 'inherit' || key.thread === 0) yield* releaseHeld(key.chat, now)
    })

  return { route, releaseHeld, routeTo }
}

/**
 * What the channel does with each new inbox entry, over the router: an answer to an offer sets a route, a chat or topic
 * goblin has not seen is read from the server's lists and offered, then the entry is routed.
 */
const taker = (input: ChannelInput, record: Recorder, ports: ChannelPorts) => {
  const { db } = input
  const { route, routeTo } = router(input, record, ports)
  const offering: Offering = { db, call: ports.call, topic: ports.topic, routeTo }

  /** A chat or topic new to goblin, offered to the owner or routed by the default; a failure is reported, not fatal. */
  const offer = (keys: readonly ChatKey[], now: number) =>
    Effect.forEach(
      keys,
      (key) =>
        discover(offering, key, now).pipe(
          Effect.catch((error) => Effect.sync(() => reportChannelFailure('offer', error))),
        ),
      { discard: true },
    )

  /** The server's chat list read into the routes, and each chat and topic new in it offered; whether it was read. */
  const sync = (now: number) =>
    Effect.gen(function* () {
      const listed = yield* syncChats(db, ports.call, now)
      yield* offer(listed.discovered, now)
      return listed.synced
    })

  /**
   * An entry's words as the owner's reply. An answer to one of goblin's questions it kept the buttons of (an `ask_user`
   * sent as buttons) is read from the server: the pressed button's label, or their reply in text mode. An answer to a
   * question goblin did not keep reads mygram's display line for the label, else its words.
   */
  const replyWords = (message: Message) =>
    Effect.gen(function* () {
      const questionId = message.questionId ?? undefined
      const buttons = questionId === undefined ? undefined : askedButtons(db, questionId)
      if (questionId !== undefined && buttons !== undefined) {
        const answered = yield* answeredQuestion(ports.call, questionId)
        const pressed = buttons.find((button) => button.id === answered?.choice)?.label
        return pressed ?? answered?.answer ?? messageText(message)
      }
      const tap = message.trigger === 'answer' ? tapOf(message.text) : undefined
      if (tap === undefined) return messageText(message)
      return tap.label === '' ? tap.choice : tap.label
    })

  /**
   * One new entry of the inbox: from the owner and not archived, in a chat goblin can name. An answer to goblin's offer
   * sets its route and starts no turn; a chat or topic goblin has not seen is read from the server's lists first and
   * offered; then the entry is routed.
   */
  const take = (message: Message, now: number) =>
    Effect.gen(function* () {
      if (message.direction !== 'in' || message.delivery === 'archive') return
      const { chat, thread } = placeOf(message)
      if (!isHandle(chat) || !Number.isSafeInteger(thread) || thread < 0) return
      const questionId = message.questionId ?? undefined
      const offered = questionId === undefined ? undefined : offerOf(db, questionId)
      if (questionId !== undefined && offered !== undefined) {
        if (offered.offer === 'open') yield* resolveOffer(offering, offered, { text: message.text, questionId }, now)
        return
      }
      const listed = unseen(db, chat, thread) ? (yield* syncChats(db, ports.call, now)).discovered : []
      const placeholders = firstSight(db, chat, thread, now)
      yield* offer([...listed, ...placeholders, { chat, thread: 0 }], now)
      yield* route(
        { entryId: message.id, chat, thread, text: yield* replyWords(message), trigger: message.trigger ?? null },
        now,
      )
    })

  return { take, sync }
}

/**
 * Reads the server's chat list when it is due (the channel was turned on, or a chat changed), then the inbox from the
 * cursor, routing each new message from the owner; the cursor follows each page.
 */
const pullPages = (input: ChannelInput, routing: ReturnType<typeof taker>, ports: ChannelPorts, now: number) =>
  Effect.gen(function* () {
    const { db } = input
    const { take, sync } = routing
    if (takeSyncDue(db) && !(yield* sync(now))) markSyncDue(db)
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const status = channelStatus(db)
      if (status === null) return
      const cursor = inboxCursor(db)
      if (cursor === undefined) return
      const inbox = yield* decodeInbox(
        yield* ports.call('inbox', { ...chatsRead(status), ...after(cursor), limit: 100 }),
      )
      if (!carries(db, status)) return
      for (const message of inbox.messages) yield* take(message, now)
      checkpoint(db, status, inbox.nextCursor)
      if (inbox.messages.length === 0) return
    }
  })

/** Where an answer goes: the Telegram chat, and its forum topic when it came from one. */
const placeArgs = (reply: { readonly tgChat: string; readonly tgThread: number }) => ({
  chat: reply.tgChat,
  ...(reply.tgThread === 0 ? {} : { threadId: reply.tgThread }),
})

type PendingReply = ReturnType<typeof pendingReplies>[number]

/**
 * One turn's answer to the chat and topic its message came from, in pieces Telegram accepts, or as buttons when it
 * stopped on a single-choice question: recorded and heard by `delivered`, sent or failed, before the next answer is
 * tried. A failed send fails the delivery; the answer stays to be sent again. A chat the bot is out of takes nothing:
 * its answer is given up.
 */
const sendAnswer = (
  { db }: ChannelInput,
  record: Recorder,
  ports: ChannelPorts,
  turn: { readonly reply: PendingReply; readonly answer: Answer | undefined; readonly now: number },
  delivered: (reply: DeliveredReply) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { reply, answer, now } = turn
    const { operationId, createdAt } = reply
    const ref = { operationId, chatId: reply.chatId ?? undefined }
    const status = routeRow(db, reply.tgChat, 0)?.status
    const out = status === 'paused' || status === 'left'
    const question = out ? undefined : answer?.question
    const pieces = out || question !== undefined ? [] : chunks(answer?.text ?? '', CHUNK)
    const sent = {
      [RunAttribute.delivery]: answer === undefined || out ? 'given_up' : 'sent',
      [RunAttribute.pieces]: pieces.length + (question === undefined ? 0 : 1),
    }
    const place = placeArgs(reply)
    // Telegram carries a button as `<question>:<option id>` in 64 bytes: each button gets a short id, its label kept.
    const buttons = (question?.options ?? []).map((option, index) => ({ id: `o${String(index)}`, label: option.label }))
    const sends = Effect.gen(function* () {
      for (const [index, piece] of pieces.entries())
        yield* ports.call('send', {
          operationId: operationIdOf(`reply-${index}`, operationId),
          text: escapeHtml(piece),
          ...place,
        })
      if (question === undefined) return undefined
      const asked = yield* ports.call('ask', {
        operationId: operationIdOf('reply-ask', operationId),
        question: escapeHtml(question.prompt),
        mode: 'choice',
        options: buttons,
        waitMs: 0,
        ...place,
      })
      const questionId = Option.getOrUndefined(decodeAsked(asked))?.id
      return questionId === undefined ? undefined : ({ questionId, options: buttons } satisfies AskedButtons)
    })
    const { outcome, asked } = yield* sends.pipe(
      Effect.map((buttonsAsked) => ({ outcome: sent[RunAttribute.delivery], asked: buttonsAsked })),
      // A chat the bot was removed from refuses the send: it is out of the chat now, and the answer is given up.
      Effect.catchTag('TelegramRefused', (refused: TelegramRefused) =>
        refused.code === 'chat_paused' || refused.code === 'chat_left'
          ? Effect.sync(() => {
              setPresence(db, reply.tgChat, refused.code === 'chat_left' ? 'left' : 'paused', now)
              return { outcome: 'given_up', asked: undefined }
            })
          : Effect.fail(refused),
      ),
      Effect.tapError((error) =>
        Effect.andThen(
          record('channel.reply', ref, createdAt * 1000, { ...sent, ...failureAttributes(error) }),
          delivered({ operationId, pieces: sent[RunAttribute.pieces], errorType: outcomeOf(error) }),
        ),
      ),
    )
    yield* record('channel.reply', ref, createdAt * 1000, { ...sent, [RunAttribute.delivery]: outcome })
    markDelivered(db, operationId, now, asked)
    yield* delivered({ operationId, pieces: sent[RunAttribute.pieces] })
  })

/** Sends every answer that is ready, or gives it up after a day; true while some are still running. */
const deliver = (
  input: ChannelInput,
  record: Recorder,
  ports: ChannelPorts,
  now: number,
  delivered: (reply: DeliveredReply) => Effect.Effect<void>,
) =>
  Effect.suspend(() =>
    deliverReady(
      pendingReplies(input.db).map((reply) => ({
        operationId: reply.operationId,
        createdAt: reply.createdAt,
        ...(reply.chatId === null ? {} : { chatId: reply.chatId }),
        ...(reply.personaId === null ? {} : { personaId: reply.personaId }),
        reply,
      })),
      now,
      ({ operationId, chatId, personaId }) =>
        ports.answer({
          operationId,
          ...(chatId === undefined ? {} : { chatId }),
          ...(personaId === undefined ? {} : { personaId }),
        }),
      ({ reply }, answer) => sendAnswer(input, record, ports, { reply, answer, now }, delivered),
    ),
  )

/**
 * The agent's Telegram channel over its rows (channel/store.ts, channel/routes.ts): turning it on and off, the routes,
 * the answers it owes, and the pull. Pulls and route changes are serialised by the channel's own `Semaphore(1)`, so a
 * message is never held after its chat's held messages were delivered (order does not matter otherwise: each pull reads
 * from the stored cursor). Nothing here holds a lock across another program.
 */
export const telegramChannel = (input: ChannelInput): Effect.Effect<Channel['Service']> =>
  Effect.map(Semaphore.make(1), (serial) => {
    const { db } = input
    const record = recorder(input)
    return Channel.of({
      status: Effect.sync(() => channelStatus(db)),
      startCursor: (connectionId, call, chats = {}) =>
        startCursor(db, connectionId, call, chats).pipe(refusedAsUpstream, Effect.withSpan('Channel.startCursor')),
      enableEvents: (connectionId, cursor, now, reach) =>
        Effect.sync(() => enableEvents(db, connectionId, cursor, now, reach)),
      setReach: (reach) => Effect.sync(() => setReach(db, reach)),
      chatsChanged: Effect.sync(() => markSyncDue(db)),
      ended: Effect.sync(() => markEnded(db)),
      disable: Effect.sync(() => disableChannel(db)),
      track: (operationId, now) =>
        Effect.sync(() => {
          if (trackReply(db, operationId, now)) input.wake()
        }),
      pull: (ports, now) =>
        serial
          .withPermit(pullPages(input, taker(input, record, ports), ports, now))
          .pipe(refusedAsUpstream, Effect.withSpan('Channel.pull')),
      route: (ports, key, choice, by, now) =>
        serial
          .withPermit(
            Effect.gen(function* () {
              const changed = setRoute(db, key, choice, by, now)
              if (changed === undefined) return undefined
              if (choice.mode !== 'inherit' || key.thread === 0)
                yield* router(input, record, ports).releaseHeld(key.chat, now)
              return changed
            }),
          )
          .pipe(refusedAsUpstream, Effect.withSpan('Channel.route')),
      sync: (ports, now) =>
        serial
          .withPermit(taker(input, record, ports).sync(now))
          .pipe(refusedAsUpstream, Effect.withSpan('Channel.sync')),
      restore: (key, choice, now) =>
        serial.withPermit(Effect.sync(() => setRoute(db, key, choice, 'owner', now)?.after)),
      revision: (kind, target) => Effect.sync(() => telegramRevision(db, kind, target)),
      newChats: (value) => Effect.sync(() => setNewChats(db, value)),
      deliver: (ports, now, delivered = () => Effect.void) =>
        deliver(input, record, ports, now, delivered).pipe(refusedAsUpstream, Effect.withSpan('Channel.deliver')),
    })
  })
