import type {
  ConversationView,
  CreateConversation,
  MoveToThread,
  QueueRemoval,
  SendMessage,
  StartThread,
  StopConversation,
  ThreadServer,
  UpdateConversation,
} from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
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
import { confineChat, confineMessage, confineUpdate } from '../keys/policy.ts'
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
import { AgentInput } from '../runtime/input.ts'
import { Retrieval } from '../retrieval/service.ts'
import { InvalidInput, attempt, toAppError } from '../http/errors.ts'
import { entryViews } from '../pi/entry-view.ts'
import { piEventResponse, sessionSnapshot } from '../pi/events.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Invocations } from '../personas/service.ts'
import { Conversations } from './service.ts'
import { moveToThread } from './mover.ts'
import { startThread, startable } from './thread-heads.ts'

/** A request that names one chat (`/conversations/:id/…`), and one that also carries a body. */
type ChatRequest = { readonly params: { readonly id: string } }
type ChatWrite<Payload> = ChatRequest & { readonly payload: Payload }

/** What came with the owner's message: App context, files and composer tags, and `personaOrder` when the body had one. */
const contextOf = ({
  appContext = [],
  attachments = [],
  selections = [],
  personaOrder,
}: Pick<SendMessage, 'appContext' | 'attachments' | 'selections' | 'personaOrder'>) => ({
  appContext,
  attachments,
  selections,
  ...(personaOrder === undefined ? {} : { personaOrder }),
})

/**
 * What an API key's request may touch (ADR 0081): a chat of its own Topics, with tags of its own Personas only. Nothing
 * for the owner's session.
 */
const confined = (chat: string, context: ReturnType<typeof contextOf>) =>
  Effect.andThen(confineChat(chat), confineMessage(context))

/** The owner's message into a chat, or an ask of the Personas it tags. */
const submit = ({ params, payload }: ChatWrite<SendMessage>) =>
  Effect.andThen(
    confined(params.id, contextOf(payload)),
    sendOwnerMessage(params.id, { text: payload.input, operationId: payload.operationId, context: contextOf(payload) }),
  )

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
const declareOn = (parent: string, payload: StartThread, servers: readonly ThreadServer[]) =>
  Effect.gen(function* () {
    // Every server is checked against the key first, and the operation's own checks too: one refused makes no thread.
    const prepared = yield* prepareServers(servers)
    yield* startable(payload.message.input, payload.message.selections)
    const conversations = yield* Conversations
    const thread = yield* conversations.startThread(parent, payload.operationId, payload.anchor)
    // A replay onto a thread closed since answers as the operation did: its servers were dropped with the close.
    if (thread.closedAt !== undefined) return
    yield* conversations.requireActing(thread.id)
    yield* applyServers(thread.id, payload.operationId, prepared)
  })

/**
 * The thread operation from a chat (ADR 0034): Reply at an entry, "+" empty, or Start thread at the chat's newest
 * settled entry, the first message answered in the Thread, its Personas in the order it asks (`personaOrder`), with the
 * MCP servers a key declares on it (ADR 0103).
 */
const threadStart = ({ params, payload }: ChatWrite<StartThread>) => {
  const context = contextOf({ ...payload.message, personaOrder: payload.personaOrder })
  const servers = payload.mcpServers ?? []
  return Effect.gen(function* () {
    yield* confined(params.id, context)
    if (servers.length > 0) yield* declareOn(params.id, payload, servers)
    const started = yield* startThread({
      parent: params.id,
      anchor: payload.anchor,
      title: payload.title,
      text: payload.message.input,
      operationId: payload.operationId,
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
    yield* confineChat(params.id)
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
    confineChat(params.id),
    Effect.map(stopChat(params.id, payload.operationId), (stopped) => ({ stopped })),
  )
const queue = ({ params }: ChatRequest) => ownerQueue(params.id)
const removeQueued = ({ params, payload }: ChatWrite<QueueRemoval>) => removeOwnerQueuedInput(params.id, payload)
const markRead = ({ params }: ChatRequest) => Effect.map(markOwnerRead(params.id), (read) => ({ read }))
const composer = ({ params }: ChatRequest) => composerOptions(params.id)

/** A registered chat's Pi snapshot. */
const snapshot = ({ params }: ChatRequest) =>
  Effect.flatMap(registeredConversation(params.id), (session) =>
    AgentInput.use(({ harness }) => attempt(() => sessionSnapshot(harness, session))),
  )

/** A page of a registered chat's history before entry `before`. */
const history = ({ params, query }: ChatRequest & { readonly query: { readonly before: number } }) =>
  Conversations.use((conversations) =>
    Effect.andThen(conversations.require(params.id), conversations.history(params.id, query.before)),
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
    yield* confineChat(params.id)
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
 * A registered chat's Pi event stream, server-sent. The stream is its own: it runs until the browser goes away, past
 * the request's scope, and stops Pi's stream then.
 */
const events = ({ params }: ChatRequest) =>
  Effect.gen(function* () {
    const session = yield* registeredConversation(params.id)
    const stream = yield* PiSessions.use((pi) => pi.events(session)).pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    return HttpServerResponse.raw(piEventResponse(stream))
  })

/**
 * The `conversations` group (ADRs 0030, 0032, 0034). Owner admission has already admitted the request; the
 * conversation services do the work, and a chat's snapshot is read from Pi through `AgentInput`.
 */
export const ConversationsHandlers = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
  handlers
    .handle('create', create)
    .handle('update', update)
    .handle('submit', submit)
    .handle('startThread', threadStart)
    .handle('move', move)
    .handle('stop', stop)
    .handle('queue', queue)
    .handle('removeQueued', removeQueued)
    .handle('markRead', markRead)
    .handle('composer', composer)
    .handle('snapshot', snapshot)
    .handle('history', history)
    .handle('entries', entries)
    .handle('sources', sources)
    .handleRaw('events', events),
)
