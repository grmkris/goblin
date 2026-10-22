import type { AppContext, AttentionReason, ComposerSelection, ResumeEntry, RunInput } from '@goblin/contracts'
import { MAX_MESSAGE, RunUserMessage, TextPart } from '@goblin/contracts'
import { Predicate } from 'effect'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InvalidInput, toAppError } from '../http/errors.ts'
import { PiSessions } from '../pi/sessions.ts'
import { openAttention } from '../streams/attention.ts'
import { ChatOperations, Conversations } from './service.ts'

// A send as goblin's programs take it, from the AG-UI `RunAgentInput` the owner API is sent (ADR 0111): the HTTP
// handler and the MCP tools (which build the input with the contract's `runInput`) read it the same way.

/** What came with a send: App context, files and composer tags, and the order of the Personas it tags. */
export type SendContext = {
  readonly appContext: readonly AppContext[]
  readonly attachments: readonly string[]
  readonly selections: readonly ComposerSelection[]
  readonly personaOrder?: 'parallel' | 'sequence'
}

/** A send: the owner's words, its operation id (the input's run id), and what came with them. */
export type Send = { readonly text: string; readonly operationId: string; readonly context: SendContext }

/**
 * The endpoint that answers an interrupt of each reason but a question: a resume naming one is refused with it, since
 * those are answered by a decision, not by words.
 */
const ANSWERED_BY: Record<Exclude<AttentionReason, 'question'>, string> = {
  approval: 'POST /api/mcp/approvals/:id',
  grant: 'PUT /api/mcp/grants',
  url: 'POST /api/mcp/url-requests/:id',
  access: 'POST /api/mcp/:id/connect',
  connect: 'POST /api/mcp/:id/connect',
  setup: 'PATCH /api/topics/:id/setup',
}

const refused = (reason: string) => Effect.fail(new InvalidInput({ reason }))

/** Whether a client's `state` says nothing: absent, null, or an empty object or list. */
const emptyState = (state: unknown): boolean =>
  state === undefined ||
  state === null ||
  (Array.isArray(state) ? state.length === 0 : Predicate.isObject(state) && Object.keys(state).length === 0)

const decodeUser = Schema.decodeUnknownOption(RunUserMessage)
const decodeText = Schema.decodeUnknownOption(TextPart)

/** The words of a user message: its content, or its parts, each of which must be text (AG-UI joins them as is). */
function wordsOf(message: RunUserMessage): Effect.Effect<string, InvalidInput> {
  if (typeof message.content === 'string') return Effect.succeed(message.content)
  const texts: string[] = []
  for (const part of message.content) {
    const text = decodeText(part)
    if (Option.isNone(text)) return refused('non_text_content')
    texts.push(text.value.text)
  }
  return Effect.succeed(texts.join(''))
}

/**
 * The words of the send's last message, which must be the user's. A send that answers interrupts may leave it out or
 * end on another role (a stock client resends its history), and then says nothing of its own.
 */
function lastWords(messages: readonly unknown[], resuming: boolean): Effect.Effect<string, InvalidInput> {
  const last = messages.at(-1)
  if (last === undefined) return resuming ? Effect.succeed('') : refused('no_user_message')
  if (!Predicate.isObject(last) || !('role' in last) || last.role !== 'user')
    return resuming ? Effect.succeed('') : refused('last_message_not_user')
  return Option.match(decodeUser(last), { onNone: () => refused('user_message_shape'), onSome: wordsOf })
}

/**
 * The answer one entry gives, if any. A cancelled entry is none; a resolved one must name an interrupt `open` holds
 * (none is checked when `open` is absent: a replay, whose questions its first send settled) that is a question, and
 * carry its answer as text. Any other interrupt is answered by its own endpoint.
 */
function answerOf(
  entry: ResumeEntry,
  open: ReadonlyMap<string, AttentionReason> | undefined,
): Effect.Effect<string | undefined, InvalidInput> {
  if (entry.status === 'cancelled') return Effect.succeed(undefined)
  const reason = open === undefined ? 'question' : open.get(entry.interruptId)
  if (reason === undefined) return refused('interrupt_not_open')
  if (reason !== 'question') return refused(`resume:${reason}:${ANSWERED_BY[reason]}`)
  if (typeof entry.payload !== 'string' || entry.payload.trim() === '') return refused('resume_payload')
  return Effect.succeed(entry.payload)
}

/** The answers of the questions `entries` resolve, in order (`answerOf`). */
const answersOf = (entries: readonly ResumeEntry[], open: ReadonlyMap<string, AttentionReason> | undefined) =>
  Effect.map(
    Effect.forEach(entries, (entry) => answerOf(entry, open)),
    (answers) => answers.filter((answer) => answer !== undefined),
  )

/** What came with the send, `forwardedProps.goblin`, each part a list. */
const contextOf = ({
  appContext = [],
  attachments = [],
  selections = [],
  personaOrder,
}: NonNullable<NonNullable<RunInput['forwardedProps']>['goblin']>): SendContext => ({
  appContext,
  attachments,
  selections,
  ...(personaOrder === undefined ? {} : { personaOrder }),
})

/**
 * `input` as a send into `chat`, given the chat's open interrupts by id with their reason (`open`; absent for a replay).
 * Refused (`InvalidInput`, a specific reason) when it names another chat, brings tools or state of its own, or its
 * last message is not the user's text; the answers of the questions it resolves are its words when its own say
 * nothing (the owner's next message settles every question before it either way). `context` is not read.
 */
export function readSend(
  chat: string,
  input: RunInput,
  open?: ReadonlyMap<string, AttentionReason>,
): Effect.Effect<Send, InvalidInput> {
  return Effect.gen(function* () {
    if (input.threadId !== chat) return yield* refused('thread_mismatch')
    if ((input.tools?.length ?? 0) > 0) return yield* refused('client_tools')
    if (!emptyState(input.state)) return yield* refused('client_state')
    const resume = input.resume ?? []
    const answers = yield* answersOf(resume, open)
    const words = yield* lastWords(input.messages, resume.length > 0)
    const text = words.trim() === '' && answers.length > 0 ? answers.join('\n\n') : words
    if (text.length > MAX_MESSAGE) return yield* refused('message_too_long')
    return { text, operationId: input.runId, context: contextOf(input.forwardedProps?.goblin ?? {}) }
  })
}

/** The interrupts open in `chat` now, by id, with their reason: the fold of its entries a stream's `/attention` is. */
const openInterrupts = (chat: string) =>
  Effect.gen(function* () {
    const session = yield* Conversations.use((conversations) => conversations.require(chat))
    const entries = yield* PiSessions.use((pi) => pi.messages(session)).pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    return new Map(openAttention(chat, entries).map(({ id, reason }) => [id, reason]))
  })

/**
 * `input` as a send into `chat` (`readSend`). The chat's open interrupts are read only when it resolves one, and not
 * for a replay of an operation the chat already admitted: its first send settled them.
 */
export const sendOf = (chat: string, input: RunInput) =>
  Effect.gen(function* () {
    const resolving = (input.resume ?? []).some(({ status }) => status === 'resolved')
    const replay = (operationId: string) =>
      Effect.map(
        ChatOperations.use((operations) => operations.receipt(chat, operationId)),
        Option.isSome,
      )
    const checked = resolving && !(yield* replay(input.runId))
    return yield* readSend(chat, input, checked ? yield* openInterrupts(chat) : undefined)
  })
