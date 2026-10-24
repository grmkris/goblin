import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { ChatId, OperationId } from '../ids.ts'
import { ComposerOptions } from '../composer.ts'
import {
  ConversationView,
  CreateConversation,
  MessageReceipt,
  SendStatus,
  StartThread,
  StartedThread,
  StopConversation,
  UpdateConversation,
} from '../conversations.ts'
import { ConversationEntries } from '../entries.ts'
import { RunInput } from '../agui/run-input.ts'
import { ConversationQueue, QueueRemoval, QueueRemovalResult } from '../queue.ts'
import { SourceUse } from '../retrieval.ts'
import { MoveReceipt, MoveToThread } from '../threads.ts'
import { ApiErrors } from './errors.ts'
import { EventStream } from './stream.ts'
import { EndpointAccess } from './access.ts'
import { GrantsResident } from './resident.ts'

/** The chat a path names: a logical chat id of 1 to 12 digits. */
const params = { id: ChatId }

/**
 * A page of a chat's history before entry `before`, oldest first: its AG-UI messages, mapped as the chat's stream maps
 * them (docs/architecture/streams.md), the entry to read the next page before (`next`), and whether older entries
 * remain.
 */
const ConversationHistory = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  next: Schema.Int,
  more: Schema.Boolean,
})

/** `?before=<entry>`: a positive safe integer. */
const HistoryQuery = {
  before: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
}

/** `?after=<entry>&limit=`: the entry to read after (0 for the first), and at most how many entries to answer. */
const EntriesQuery = {
  after: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
}

/**
 * The owner's conversations and threads (ADRs 0030, 0032, 0034). Paths are relative to the API's `/api` prefix; every
 * endpoint can also answer owner admission's failures (`OwnerAdmission` in `owner.ts`), and `error` names the ones the
 * endpoint itself produces.
 *
 * - `create`: `POST /api/conversations`, 201: the thread operation without a message (`CreateConversation`), a Thread
 *   branched from an entry of an open chat or an empty one.
 * - `update`: `PATCH /api/conversations/:id` renames, closes or reopens, or pins a subagent open.
 * - `submit`: `POST …/:id/messages`, a send as AG-UI's `RunAgentInput` (`RunInput`, ADR 0111): the owner's message, or
 *   an ask of the Personas it tags. 202 with Pi's receipt; asked with `Accept: text/event-stream`, 200 and the run that
 *   took the send as AG-UI events instead (docs/architecture/streams.md, "Driving a chat"), which the typed client
 *   never asks for.
 * - `startThread`: `POST …/:id/threads`, 201: the thread operation (`StartThread`): one call makes the Thread once per
 *   run id of its message and sends that message as its first, answered there.
 * - `move`: `POST …/:id/move`: Move to thread, as its receipt. The same operation id finds the same move.
 * - `stop`: `POST …/:id/stop`: Stop in the chat; `stopped` says whether anything was running.
 * - `sendStatus`: `GET …/:id/sends/:operationId`: how one send stands now (`SendStatus`, ADR 0119): queued, working
 *   and its step, answered with its text, or unanswered. It does not grant resident authority.
 * - `queue` / `removeQueued`: `GET` and `DELETE …/:id/queue`: the owner's queued inputs, and withdrawing one.
 * - `markRead`: `PUT …/:id/read`: the owner has seen the newest reply.
 * - `composer`: `GET …/:id/composer`: what the composer can tag in the chat.
 * - `history`: `GET …/:id/history?before=`: a page of older messages, as AG-UI messages.
 * - `entries`: `GET …/:id/entries?after=&limit=`: entries after a cursor, oldest first, normalized for a server
 *   (`ConversationEntries`), with the chat's activity and Persona invocations. It does not grant resident authority.
 * - `sources`: `GET …/:id/sources`: what retrieval gave the chat's answers (ADR 0035), newest first.
 * - `stream`: `GET …/:id/stream`, server-sent: the chat's AG-UI events, every one in full, one `data:` frame each
 *   (docs/architecture/streams.md, ADR 0110). It opens with `MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT` and the run in
 *   flight, then follows the chat until the reader goes away (at most fifteen minutes; a reconnect opens afresh).
 *   `Conflict` `stream_busy` past the readers a chat or the workspace takes. It does not grant resident authority.
 *
 * A credential reaches `update`, `submit`, `startThread` and `stop` with `write`, and `entries`, `sendStatus` and
 * `stream` with `read` (ADRs 0081, 0086, 0090, 0114, 0119): only in the Topics its grant reaches, and never
 * `keepOpen`.
 */
export class ConversationsGroup extends HttpApiGroup.make('conversations').add(
  HttpApiEndpoint.post('create', '/conversations', {
    payload: CreateConversation,
    success: ConversationView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.patch('update', '/conversations/:id', {
    params,
    payload: UpdateConversation,
    success: ConversationView,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.post('submit', '/conversations/:id/messages', {
    params,
    payload: RunInput,
    success: MessageReceipt.pipe(HttpApiSchema.status(202)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.budgetExhausted],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.post('startThread', '/conversations/:id/threads', {
    params,
    payload: StartThread,
    success: StartedThread.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.budgetExhausted],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.post('move', '/conversations/:id/move', {
    params,
    payload: MoveToThread,
    success: MoveReceipt,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('stop', '/conversations/:id/stop', {
    params,
    payload: StopConversation,
    success: Schema.Struct({ stopped: Schema.Boolean }),
    error: [ApiErrors.notFound],
  }).annotate(EndpointAccess, { level: 'write' }),
  HttpApiEndpoint.get('sendStatus', '/conversations/:id/sends/:operationId', {
    params: { ...params, operationId: OperationId },
    success: SendStatus,
    error: [ApiErrors.notFound],
  })
    .annotate(EndpointAccess, { level: 'read' })
    .annotate(GrantsResident, false),
  HttpApiEndpoint.get('queue', '/conversations/:id/queue', {
    params,
    success: ConversationQueue,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.delete('removeQueued', '/conversations/:id/queue', {
    params,
    payload: QueueRemoval,
    success: QueueRemovalResult,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.put('markRead', '/conversations/:id/read', {
    params,
    success: Schema.Struct({ read: Schema.Boolean }),
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('composer', '/conversations/:id/composer', {
    params,
    success: ComposerOptions,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.get('history', '/conversations/:id/history', {
    params,
    query: HistoryQuery,
    success: ConversationHistory,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('entries', '/conversations/:id/entries', {
    params,
    query: EntriesQuery,
    success: ConversationEntries,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  })
    .annotate(EndpointAccess, { level: 'read' })
    .annotate(GrantsResident, false),
  HttpApiEndpoint.get('sources', '/conversations/:id/sources', {
    params,
    success: Schema.Array(SourceUse),
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('stream', '/conversations/:id/stream', {
    params,
    success: EventStream,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  })
    .annotate(EndpointAccess, { level: 'read' })
    .annotate(GrantsResident, false),
) {}
