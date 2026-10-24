import type {
  AguiEvent,
  ConversationView,
  CreateConversation,
  MoveToThread,
  QueueRemoval,
  RunInput,
  StartThread,
  StopConversation,
  ThreadAnchor,
  ThreadServer,
  UpdateConversation,
} from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  createOwnerConversation,
  markOwnerRead,
  registeredConversation,
  sendOwnerMessage,
  stopChat,
  updateOwnerConversation,
} from '../agent-program.ts'
import { composerOptions } from '../composer.ts'
import { reachesChat, confineMessage, confineUpdate } from '../grants/policy.ts'
import { sendOf } from './run-input.ts'
import {
  applyServers,
  checkApply,
  dropThreadServers,
  prepareServers,
  requireThread,
  threadServerViews,
} from '../mcp/thread-servers.ts'
import { Db } from '../runtime/db.ts'
import { ownerQueue, removeOwnerQueuedInput } from '../conversation-queue.ts'
import { Retrieval } from '../retrieval/service.ts'
import { InvalidInput, NotFound, toAppError } from '../http/errors.ts'
import { entryViews } from '../pi/entry-view.ts'
import { entryMessages } from '../streams/messages.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Invocations } from '../personas/service.ts'
import { sseFrames } from '../streams/frames.ts'
import { RunStreams, Streams } from '../streams/service.ts'
import { settledWithin } from './instance.ts'
import { stepOf } from './send-status.ts'
import { Conversations } from './service.ts'
import { moveToThread } from './mover.ts'
import { startThread } from './thread-heads.ts'

/** A request that names one chat (`/conversations/:id/…`), and one that also carries a body. */
type ChatRequest = { readonly params: { readonly id: string } }
type ChatWrite<Payload> = ChatRequest & { readonly payload: Payload }

/**
 * A send into a chat, read from its AG-UI input (ADR 0111): what an API key's request may touch (ADR 0081) is checked
 * first, a chat of its own Topics, then what came with it, tags of its own Personas only. Nothing for the owner's
 * session.
 */
const confinedSend = (chat: string, input: RunInput) =>
  Effect.gen(function* () {
    yield* reachesChat(chat)
    const send = yield* sendOf(chat, input)
    yield* confineMessage(send.context)
    return send
  })

/** What a chat's stream and a send's run are answered with: server-sent events, never cached. */
const SSE_HEADERS = { 'cache-control': 'no-store', 'content-type': 'text/event-stream' }

/** `batches` as a server-sent events answer (`streams/frames.ts`); the body runs on its own past the request's scope. */
const eventsAnswer = (batches: Stream.Stream<readonly AguiEvent[]>, signal?: AbortSignal) =>
  HttpServerResponse.raw(
    new Response(
      Stream.toReadableStreamWith(sseFrames(batches), Context.empty(), signal === undefined ? {} : { signal }),
      {
        headers: SSE_HEADERS,
      },
    ),
  )

/** Whether a request asks to be answered with server-sent events. */
const wantsEvents = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.headers['accept'] ?? '').includes('text/event-stream')

/**
 * The owner's message into a chat, or an ask of the Personas it tags (ADR 0111): Pi's receipt, or, asked for
 * server-sent events, the run that took it as AG-UI events (`RunStreams`, docs/architecture/streams.md "Driving a
 * chat"), its watch opened before the send is admitted.
 */
const submit = ({
  params,
  payload,
  request,
}: ChatWrite<RunInput> & { readonly request: HttpServerRequest.HttpServerRequest }) =>
  Effect.gen(function* () {
    const send = yield* confinedSend(params.id, payload)
    const admit = sendOwnerMessage(params.id, send)
    if (!wantsEvents(request)) return yield* admit
    yield* registeredConversation(params.id)
    const ask = send.context.selections.some(({ kind }) => kind === 'persona')
    const target = { chat: params.id, runId: send.operationId, ask }
    return eventsAnswer(yield* RunStreams.use((runs) => runs.follow(target, admit)))
  })

/** `view` with the thread's declared servers (ADR 0103), when it has any; never a token. */
const withServers = (view: ConversationView) =>
  Effect.map(
    Db.useSync((db) => threadServerViews(db, view.id)),
    (servers) => (servers.length === 0 ? view : { ...view, mcpServers: servers }),
  )

/**
 * The servers a thread operation declares, on the thread it makes or finds, before its first message is sent, so the
 * Personas it tags freeze them with their tools (ADR 0103); a replay with new tokens makes those the live ones.
 */
const declareOn = (parent: string, operationId: string, anchor: ThreadAnchor, servers: readonly ThreadServer[]) =>
  Effect.gen(function* () {
    // Every server is checked against the key first: one refused makes no thread.
    const prepared = yield* prepareServers(servers)
    const conversations = yield* Conversations
    const thread = yield* conversations.startThread(parent, operationId, anchor)
    yield* conversations.requireActing(thread.id)
    yield* applyServers(thread.id, operationId, prepared)
  })

/**
 * The thread operation from a chat (ADR 0034): Reply at an entry, "+" empty, or Start thread at the chat's newest
 * settled entry, the first message (a send, its run id the operation's) answered in the Thread, its Personas in the
 * order it asks (`personaOrder`), with the MCP servers a key declares on it (ADR 0103).
 */
const threadStart = ({ params, payload }: ChatWrite<StartThread>) => {
  const servers = payload.mcpServers ?? []
  return Effect.gen(function* () {
    const { text, operationId, context } = yield* confinedSend(params.id, payload.message)
    if (servers.length > 0) yield* declareOn(params.id, operationId, payload.anchor, servers)
    const started = yield* startThread({
      parent: params.id,
      anchor: payload.anchor,
      title: payload.title,
      text,
      operationId,
      context,
    })
    return { ...started, thread: yield* withServers(started.thread) }
  })
}

const create = ({ payload }: { readonly payload: CreateConversation }) => createOwnerConversation(payload)
/**
 * A change of a thread's declared servers (ADR 0103), checked before the request writes anything: a Thread only, open,
 * every server within the key's grant (the owner may only clear them), and an operation that may still set them.
 */
const preparedFor = (chat: string, change: NonNullable<UpdateConversation['mcpServers']>, closing: boolean) =>
  Effect.gen(function* () {
    if (closing && change.set.length > 0) return yield* new InvalidInput({ reason: 'thread_servers_closed' })
    yield* requireThread(chat)
    const prepared = yield* prepareServers(change.set)
    yield* Conversations.use((conversations) => conversations.requireActing(chat))
    yield* checkApply(chat, change.operationId, prepared)
    return prepared
  })

/**
 * Rename, close or reopen: a key only its own chats, and never pinning a subagent open (ADR 0090); a key also replaces
 * its thread's declared servers, and the owner may clear them (ADR 0103), checked before anything is written. Closing
 * drops the servers of the thread and every chat under it, and reopening restores none.
 */
const update = ({ params, payload }: ChatWrite<UpdateConversation>) =>
  Effect.gen(function* () {
    const { mcpServers, ...change } = payload
    yield* reachesChat(params.id)
    yield* confineUpdate(change)
    const prepared =
      mcpServers === undefined ? undefined : yield* preparedFor(params.id, mcpServers, change.closed === true)
    const closing = change.closed === true ? yield* Conversations.use((each) => each.subtree(params.id)) : []
    const view = yield* updateOwnerConversation(params.id, change)
    if (mcpServers !== undefined && prepared !== undefined)
      yield* applyServers(params.id, mcpServers.operationId, prepared)
    if (closing.length > 0) yield* dropThreadServers(closing)
    return yield* withServers(view)
  })
const move = ({ params, payload }: ChatWrite<MoveToThread>) => moveToThread(params.id, payload)
const stop = ({ params, payload }: ChatWrite<StopConversation>) =>
  Effect.andThen(
    reachesChat(params.id),
    Effect.map(stopChat(params.id, payload.operationId), (stopped) => ({ stopped })),
  )
/** How long a send's status read waits to see whether Pi settled it: enough for a settled one, never a real wait. */
const SETTLED_PEEK_MS = 50

/**
 * How one send of a registered chat stands now (ADR 0119), what `tasks/get` and `conversation_send_status` read:
 * settled (answered or not) as Pi says, else queued behind earlier work, else working, its step read from the chat's
 * newest page. Pi answers a send it never took as `not_found`, which is `NotFound` `operation`.
 */
const sendStatus = ({ params }: { readonly params: { readonly id: string; readonly operationId: string } }) =>
  Effect.gen(function* () {
    yield* reachesChat(params.id)
    const session = yield* registeredConversation(params.id)
    const settled = yield* settledWithin(session, params.operationId, SETTLED_PEEK_MS)
    if (Option.isSome(settled)) {
      const { status, text, reason } = settled.value
      if (status === 'done') return { status: 'answered' as const, text: text ?? '' }
      if (reason === 'not_found') return yield* new NotFound({ what: 'operation' })
      return { status: 'unanswered' as const, reason: reason ?? 'unanswered' }
    }
    const pending = yield* PiSessions.use((pi) => pi.pending(session)).pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    if (pending.some((each) => each.operationId === params.operationId && each.status === 'queued'))
      return { status: 'queued' as const }
    const { entries } = yield* Conversations.use((conversations) =>
      conversations.history(params.id, Number.MAX_SAFE_INTEGER),
    )
    return { status: 'working' as const, step: stepOf(params.id, entries) }
  })

const queue = ({ params }: ChatRequest) => ownerQueue(params.id)
const removeQueued = ({ params, payload }: ChatWrite<QueueRemoval>) => removeOwnerQueuedInput(params.id, payload)
const markRead = ({ params }: ChatRequest) => Effect.map(markOwnerRead(params.id), (read) => ({ read }))
const composer = ({ params }: ChatRequest) => composerOptions(params.id)

/**
 * A page of a registered chat's history before entry `before`, as AG-UI messages mapped as its stream maps them
 * (`streams/messages.ts`), with the entry the next page starts before.
 */
const history = ({ params, query }: ChatRequest & { readonly query: { readonly before: number } }) =>
  Conversations.use((conversations) =>
    Effect.gen(function* () {
      yield* conversations.require(params.id)
      const { entries, more } = yield* conversations.history(params.id, query.before)
      const [oldest] = entries
      return {
        messages: entries.flatMap((entry) => entryMessages(params.id, entry)),
        next: oldest === undefined ? query.before : Number(oldest.id),
        more,
      }
    }),
  )

/** How many entries a forward read answers unless it asks for fewer, and how many of the chat's invocations. */
const ENTRIES = 50
const INVOCATIONS = 20

/**
 * A registered chat's entries after a cursor, oldest first, as a server reads them (ADR 0081): at most `limit` of Pi's
 * entries looked at, the cursor to read from next, the chat's activity and its newest Persona invocations.
 */
const entries = ({
  params,
  query,
}: ChatRequest & { readonly query: { readonly after: number; readonly limit?: number | undefined } }) =>
  Effect.gen(function* () {
    yield* reachesChat(params.id)
    const session = yield* registeredConversation(params.id)
    const records = yield* Conversations.use((conversations) => conversations.after(params.id, query.after))
    const page = records.slice(0, query.limit ?? ENTRIES)
    const busy = yield* PiSessions.use((pi) => pi.busy(session)).pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    const invocations = yield* Invocations.use((each) => each.ofChat(params.id, INVOCATIONS))
    const last = page.at(-1)
    return {
      entries: page.flatMap(entryViews),
      next: last === undefined ? query.after : Number(last.id),
      more: records.length > page.length,
      activity: busy ? ('working' as const) : ('idle' as const),
      invocations,
    }
  })

/** What retrieval gave a registered chat's answers (ADR 0035), newest first: its source strips. */
const sources = ({ params }: ChatRequest) =>
  Effect.andThen(
    registeredConversation(params.id),
    Retrieval.use((retrieval) => retrieval.uses(params.id)),
  )

/**
 * A registered chat's AG-UI stream as server-sent events (docs/architecture/streams.md): its opening, then everything
 * that happens in it, until the reader goes away or the producer lets it go (then the connection ends, read or not);
 * a reader that comes back connects again for a fresh opening. A key reaches only its own room's chats. The body runs
 * on its own past the request's scope, and lets go of the chat when it ends.
 */
const stream = ({ params }: ChatRequest) =>
  Effect.gen(function* () {
    yield* reachesChat(params.id)
    yield* registeredConversation(params.id)
    const { batches, released } = yield* Streams.use((streams) => streams.watch(params.id))
    return eventsAnswer(batches, released)
  })

/**
 * The `conversations` group (ADRs 0030, 0032, 0034). Owner admission has already admitted the request; the
 * conversation services do the work, and a chat's stream is the producer's (`Streams`, ADR 0110).
 */
export const ConversationsHandlers = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
  handlers
    .handle('create', create)
    .handle('update', update)
    .handle('submit', submit)
    .handle('startThread', threadStart)
    .handle('move', move)
    .handle('stop', stop)
    .handle('sendStatus', sendStatus)
    .handle('queue', queue)
    .handle('removeQueued', removeQueued)
    .handle('markRead', markRead)
    .handle('composer', composer)
    .handle('history', history)
    .handle('entries', entries)
    .handle('sources', sources)
    .handleRaw('stream', stream),
)
