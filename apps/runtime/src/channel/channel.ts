// The Telegram channel (ADRs 0009, 0055): one MCP connection the owner chose, mygram's bound to the agent's own bot
// (directly, or through mysi), carries Telegram both ways. The server's Events wake the agent (channel/program.ts); it
// then reads the inbox from its cursor, every chat the grant reaches in one
// stream, and routes each new message from the owner by its chat and forum topic (channel/routes.ts): a turn in the
// Topic of its route answered by goblin or a Persona, a note kept there, nothing, or held while the chat waits for the
// owner's choice. Each answer goes back to the chat and topic its message came from. The rows are channel/store.ts and
// channel/routes.ts; the server's tools are channel/tools.ts.
import { type ChannelStatus, TELEGRAM_AUTHOR, TELEGRAM_DM, TelegramChatHandle } from '@goblin/contracts'
import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { chatSession, operationSession, primaryChat } from '../chats/directory.ts'
import { type AppError, InvalidInput, toAppError } from '../http/errors.ts'
import { writeLine } from '../observability/logger.ts'
import { failureAttributes, outcomeOf } from '../telemetry/attributes.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import { expectedFailure } from '../telemetry/safety.ts'
import {
  type Held,
  effectiveRoute,
  heldOf,
  hold,
  release,
  routeRow,
  seeChat,
  setPresence,
  setRoute,
  takeDropped,
} from './routes.ts'
import { Channel } from './service.ts'
import {
  type ReplyTarget,
  carries,
  channelStatus,
  checkpoint,
  disableChannel,
  enableEvents,
  inboxCursor,
  markDelivered,
  pendingReplies,
  markEnded,
  markSyncDue,
  setNewChats,
  setReach,
  storedCursor,
  takeSyncDue,
  trackReply,
} from './store.ts'
import { syncChats } from './sync.ts'
import { type ChannelCall, type TelegramRefused, refusedAsUpstream } from './tools.ts'

/** Pages of 100 read at most per pull. */
const MAX_PAGES = 50
/** Pages of 100 read at most to find the end of the inbox when the channel is turned on. */
const MAX_HISTORY_PAGES = 200
/** How long a turn's answer is waited for before it is given up. */
const REPLY_DAYS = 1
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

/** One message from the owner into a goblin Topic: where, under which operation, from whom, and its words. */
export type Turn = {
  readonly topic: number
  readonly operationId: string
  readonly author: string
  readonly text: string
}

/** A single-choice question an answer ended on, as Telegram buttons can ask it. */
export type AskedChoice = {
  readonly prompt: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
}

/** How a turn ended for Telegram: its words, and the question with buttons it asked when it stopped on one. */
export type Answer = { readonly text: string; readonly question?: AskedChoice }

/** Which turn an answer belongs to: its operation, the goblin chat it ran in and the Persona that answers it. */
export type ReplyRef = { readonly operationId: string; readonly chatId?: string; readonly personaId?: number }

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
  /** How a turn ended, once it has; undefined while it runs. */
  readonly answer: (reply: ReplyRef) => Effect.Effect<Answer | undefined, AppError>
}

/** One answer's delivery to Telegram: the turn's operation id, how many messages it took, and why it failed if it did. */
export type DeliveredReply = { readonly operationId: string; readonly pieces: number; readonly errorType?: string }

/** An operation id mygram accepts (letters, digits, `_` and `-`, at most 100). */
const myagentId = (prefix: string, id: string) => `${prefix}-${id.replaceAll(/[^\w-]/gu, '-')}`.slice(0, 100)

/** Plain text as Telegram HTML. */
export const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** `text` in pieces Telegram accepts, split at paragraph or line breaks where it can. */
export function chunks(text: string): readonly string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > CHUNK) {
    const window = rest.slice(0, CHUNK)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const at = cut > CHUNK / 2 ? cut : CHUNK
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

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
export interface ChannelInput {
  readonly db: DrizzleSqliteDODatabase
  readonly telemetry: RunTelemetry | undefined
  /** Asks the agent to send the answers that are ready (a schedule of its own). */
  readonly wake: () => void
}

/** One message in, one answer out, in the run ledger (ADR 0024), by the turn's operation id and the chat it ran in. */
const recorder =
  ({ db, telemetry }: ChannelInput) =>
  (
    kind: 'channel.received' | 'channel.reply',
    turn: { readonly operationId: string; readonly chatId: string | undefined },
    startedAt: number,
    extra: RunAttributes,
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
      Effect.sync(() => {
        const chat = turn.chatId ?? primaryChat
        telemetry?.record({
          id: `${kind === 'channel.received' ? 'channel' : 'reply'}:${turn.operationId}`,
          kind,
          status: RunAttribute.errorType in extra ? 'error' : 'ok',
          conversationId: operationSession(db, chat, turn.operationId) ?? chatSession(db, chat),
          operationId: turn.operationId,
          startedAt,
          endedAt,
          attributes: { [RunAttribute.channel]: 'telegram', ...extra },
        })
      }),
    )
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
const firstSight = (db: DrizzleSqliteDODatabase, chat: string, thread: number, now: number): void => {
  const known = routeRow(db, chat, 0)
  const dm = chat === TELEGRAM_DM
  const kind = known?.kind ?? (dm ? 'private' : 'group')
  if (known === undefined) seeChat(db, { chat, thread: 0, title: dm ? 'Telegram' : 'Telegram group', kind }, now)
  else if (known.status === 'paused' || known.status === 'left') setPresence(db, chat, 'active', now)
  if (thread > 0 && routeRow(db, chat, thread) === undefined)
    seeChat(db, { chat, thread, title: `Topic ${String(thread)}`, kind }, now)
}

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
      const operationId = myagentId('telegram', held.entryId)
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
      let note = dropped === 0 ? '' : `(${String(dropped)} earlier messages were not kept while this chat waited.)\n`
      for (const held of ready) {
        yield* route(held, now, note)
        release(db, held.entryId)
        note = ''
      }
    })

  /** One new entry of the inbox: from the owner and not archived, in a chat goblin can name, then routed. */
  const take = (message: Message, now: number) =>
    Effect.gen(function* () {
      if (message.direction !== 'in' || message.delivery === 'archive') return
      const { chat, thread } = placeOf(message)
      if (!isHandle(chat) || !Number.isSafeInteger(thread) || thread < 0) return
      yield* Effect.sync(() => firstSight(db, chat, thread, now))
      yield* route(
        { entryId: message.id, chat, thread, text: messageText(message), trigger: message.trigger ?? null },
        now,
      )
    })

  return { route, releaseHeld, take }
}

/**
 * Reads the server's chat list when it is due (the channel was turned on, or a chat changed), then the inbox from the
 * cursor, routing each new message from the owner; the cursor follows each page.
 */
const pullPages = (input: ChannelInput, take: ReturnType<typeof router>['take'], ports: ChannelPorts, now: number) =>
  Effect.gen(function* () {
    const { db } = input
    if (takeSyncDue(db) && !(yield* syncChats(db, ports.call, now)).synced) markSyncDue(db)
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
    const pieces = out || question !== undefined ? [] : chunks(answer?.text ?? '')
    const sent = {
      [RunAttribute.delivery]: answer === undefined || out ? 'given_up' : 'sent',
      [RunAttribute.pieces]: pieces.length + (question === undefined ? 0 : 1),
    }
    const place = placeArgs(reply)
    const sends = [
      ...pieces.map((piece, index) =>
        ports.call('send', {
          operationId: myagentId(`reply-${index}`, operationId),
          text: escapeHtml(piece),
          ...place,
        }),
      ),
      ...(question === undefined
        ? []
        : [
            ports.call('ask', {
              operationId: myagentId('reply-ask', operationId),
              question: escapeHtml(question.prompt),
              mode: 'choice',
              options: question.options.map((option) => ({ id: option.id, label: option.label })),
              waitMs: 0,
              ...place,
            }),
          ]),
    ]
    const outcome = yield* Effect.forEach(sends, (send) => send, { discard: true }).pipe(
      Effect.as(sent[RunAttribute.delivery]),
      // A chat the bot was removed from refuses the send: it is out of the chat now, and the answer is given up.
      Effect.catchTag('TelegramRefused', (refused: TelegramRefused) =>
        refused.code === 'chat_paused' || refused.code === 'chat_left'
          ? Effect.sync(() => {
              setPresence(db, reply.tgChat, refused.code === 'chat_left' ? 'left' : 'paused', now)
              return 'given_up'
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
    markDelivered(db, operationId, now)
    yield* delivered({ operationId, pieces: sent[RunAttribute.pieces] })
  })

/** Sends every answer that is ready; true while some are still running. */
const deliver = (
  input: ChannelInput,
  record: Recorder,
  ports: ChannelPorts,
  now: number,
  delivered: (reply: DeliveredReply) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    let waiting = false
    for (const reply of pendingReplies(input.db)) {
      const answer = yield* ports.answer({
        operationId: reply.operationId,
        ...(reply.chatId === null ? {} : { chatId: reply.chatId }),
        ...(reply.personaId === null ? {} : { personaId: reply.personaId }),
      })
      if (answer === undefined && now - reply.createdAt < REPLY_DAYS * 86_400) waiting = true
      else yield* sendAnswer(input, record, ports, { reply, answer, now }, delivered)
    }
    return waiting
  })

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
          .withPermit(pullPages(input, router(input, record, ports).take, ports, now))
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
      newChats: (value) => Effect.sync(() => setNewChats(db, value) !== undefined),
      deliver: (ports, now, delivered = () => Effect.void) =>
        deliver(input, record, ports, now, delivered).pipe(refusedAsUpstream, Effect.withSpan('Channel.deliver')),
    })
  })
