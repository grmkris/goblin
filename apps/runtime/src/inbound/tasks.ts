import { ChatId, OperationId, type SendStatus } from '@goblin/contracts'
import { AppError } from '@goblin/contracts/api'
import { type McpServer, ProtocolError } from '@modelcontextprotocol/server'
import type * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { toAppError } from '../http/errors.ts'
import { base64url, bytesOfBase64url } from '../runtime/purpose-key.ts'
import { TASKS_EXTENSION, callContextOf } from './access.ts'
import type { OwnerClient } from './client.ts'
import type { CallerReach } from './mcp-server.ts'
import { workspaceFor } from './reach.ts'
import { type CallTarget, type OwnerCaller, type Power, type Reply, failed, offers, standard } from './tools.ts'

// A send as a task (ADR 0119, the Tasks extension of the 2026-07-28 protocol, SEP-2663): `conversation_send` and
// `thread_start` answer a `CreateTaskResult` to a client that declared the extension on that request, and the task's
// state is the send's own (`GET /api/conversations/:id/sends/:operationId`, read by `tasks/get` as by the
// `conversation_send_status` tool), so any isolate answers for it and nothing is stored for the task itself. Any other
// client gets the receipt as before and polls. No progress notifications: the extension has none; the send's step is
// the task's `statusMessage`.

/** How often a client should poll a working task, and how long goblin answers for one after it was made. */
const POLL_MS = 2000
const TTL_MS = 24 * 60 * 60 * 1000

/**
 * What routes a task to its send: the workspace it was made in (an id, checked against the caller's reach at every
 * read, as a `workspace` argument is), its chat, the send's operation id, and when it was made (epoch milliseconds).
 */
export interface TaskRef {
  readonly workspace: string
  readonly chat: string
  readonly operationId: string
  readonly createdAt: number
}

/** The id's version, so a later shape never reads as this one. */
const PREFIX = 't1.'
const RefParts = Schema.fromJsonString(
  Schema.Tuple([
    Schema.String.check(Schema.isMaxLength(200)),
    ChatId,
    OperationId,
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
)
const encodeRef = Schema.encodeSync(RefParts)
const decodeRef = Schema.decodeUnknownOption(RefParts)

/** A task's id: opaque to the client, `t1.` and its route as base64url JSON. It grants nothing: every read checks. */
export const taskIdOf = (ref: TaskRef): string =>
  `${PREFIX}${base64url(new TextEncoder().encode(encodeRef([ref.workspace, ref.chat, ref.operationId, ref.createdAt])))}`

/** The route a task id names, or none for one goblin did not make (or of another shape). */
export const taskRefOf = (taskId: string): TaskRef | undefined => {
  const body = taskId.slice(PREFIX.length)
  if (!taskId.startsWith(PREFIX) || !/^[\w-]{1,1000}$/u.test(body)) return undefined
  let json: string
  try {
    json = new TextDecoder().decode(bytesOfBase64url(body))
  } catch {
    // expected: text that is no base64url names no task.
    return undefined
  }
  const parts = Option.getOrUndefined(decodeRef(json))
  return parts === undefined
    ? undefined
    : { workspace: parts[0], chat: parts[1], operationId: parts[2], createdAt: parts[3] }
}

/** The fields every task carries but its status. */
const taskBase = (taskId: string, ref: TaskRef, now: number) => ({
  taskId,
  createdAt: new Date(ref.createdAt).toISOString(),
  lastUpdatedAt: new Date(now).toISOString(),
  ttlMs: TTL_MS,
  pollIntervalMs: POLL_MS,
})

/**
 * What `conversation_send` and `thread_start` answer a client that follows tasks: the send's task, working. Its empty
 * `content` is what the SDK gives any tool result without one; the 2026-07-28 encoding keeps a `tools/call` result's
 * own `resultType`.
 */
export const createdTask = (taskId: string, ref: TaskRef) => ({
  content: [],
  resultType: 'task' as const,
  ...taskBase(taskId, ref, ref.createdAt),
  status: 'working' as const,
  statusMessage: 'accepted',
})

/** Pi's reasons for a send that ended because it was stopped: the task is then `cancelled`. */
const STOPPED: ReadonlySet<string> = new Set(['aborted', 'withdrawn'])

/**
 * A send's status as its task (SEP-2663's DetailedTask): `working` while queued or running, its step as the
 * `statusMessage`; `completed` with the answer as a `CallToolResult` (its text, and the chat, operation and text as
 * structured content); `cancelled` when it was stopped; and `completed` with `isError` when it ended without an answer
 * otherwise, since `failed` is only for a request that failed as a protocol error.
 */
export function taskOf(taskId: string, ref: TaskRef, send: SendStatus, now: number) {
  const base = taskBase(taskId, ref, now)
  const about = { chat: ref.chat, operationId: ref.operationId }
  switch (send.status) {
    case 'queued':
      return { ...base, status: 'working' as const, statusMessage: 'waiting for its turn' }
    case 'working':
      return { ...base, status: 'working' as const, statusMessage: send.step }
    case 'answered':
      return {
        ...base,
        status: 'completed' as const,
        statusMessage: 'answered',
        result: {
          content: [{ type: 'text' as const, text: send.text }],
          structuredContent: { ...about, text: send.text },
        },
      }
    case 'unanswered':
      return STOPPED.has(send.reason)
        ? { ...base, status: 'cancelled' as const, statusMessage: 'stopped' }
        : {
            ...base,
            status: 'completed' as const,
            statusMessage: 'ended without an answer',
            result: {
              content: [{ type: 'text' as const, text: `The send ended without an answer (${send.reason}).` }],
              structuredContent: { ...about, reason: send.reason },
              isError: true,
            },
          }
  }
}

/** -32021: the request did not declare what the method needs (SEP-2663 and the 2026-07-28 protocol). */
const MISSING_CAPABILITY = -32021

/** The refusal of `tasks/*` from a request that did not declare the extension. */
const notDeclared = () =>
  new ProtocolError(MISSING_CAPABILITY, 'Missing required client capability', {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  })

/** An id goblin never made, or one whose send the caller does not reach (any more): the protocol's unknown task. */
const unknownTask = () => new ProtocolError(-32602, 'Unknown task')

const encodeError = Schema.encodeSync(AppError)

/** A failure of the call behind a task method: not there (or out of reach) is an unknown task; any other is internal. */
const methodError = (cause: unknown): ProtocolError =>
  Match.value(toAppError(cause)).pipe(
    Match.tags({ NotFound: unknownTask, AccessInsufficient: unknownTask, Forbidden: unknownTask }),
    Match.orElse((error) => new ProtocolError(-32603, 'InternalError', encodeError(error))),
  )

/**
 * Where a call is answered: for a client, the workspace a call names among those it reaches (`workspaceFor`), its id;
 * for a server's key, its own workspace, which every call of a key reaches whatever it names.
 */
export type Home = (named: string | undefined) => string

/** The home of a caller: a client's workspace by its reach, a key's own (its credential's `ws.workspace`). */
export const homeOf = (power: Power, reach: CallerReach | undefined): Home => {
  const ws: unknown = Predicate.hasProperty(power, 'ws') ? power.ws : undefined
  const own = Predicate.hasProperty(ws, 'workspace') && Predicate.isString(ws.workspace) ? ws.workspace : ''
  return (named) => (reach === undefined ? own : workspaceFor(reach, named).id)
}

/** What a send's call answers: its chat and its receipt's operation id, which name the send's task. */
type Sent = { readonly chat: string; readonly operationId: string }

/**
 * A send as the tool answers it: to a client that declared the Tasks extension on this request, the task that tracks
 * it once the send is accepted (`createdTask`); to any other, `reply`'s answer (the receipt, or the refusal) as before.
 */
export const trackerWith =
  (call: OwnerCaller, target: CallTarget, home: Home) =>
  async <A>(
    run: (api: OwnerClient) => Effect.Effect<A, unknown>,
    sent: (value: A) => Sent,
    reply: Reply,
  ): Promise<Awaited<ReturnType<Reply>> | ReturnType<typeof createdTask>> => {
    // Read before the first await: the call that started this send names its workspace only while it starts.
    const named = target.current
    if (target.context?.tasks !== true) return reply(run)
    try {
      const workspace = home(named)
      const { chat, operationId } = sent(await call(run, named))
      const ref = { workspace, chat, operationId, createdAt: Date.now() }
      return createdTask(taskIdOf(ref), ref)
    } catch (cause) {
      // expected: the failure is the tool's error result, as any tool's (tools.ts).
      return failed(cause)
    }
  }

const TaskParams = standard(Schema.Struct({ taskId: Schema.String }))
const UpdateParams = standard(
  Schema.Struct({
    taskId: Schema.String,
    inputResponses: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

/**
 * Declares the Tasks extension and serves its methods when the credential's grant reaches a send's status (`read`):
 * `tasks/get` reads the send (`conversations.sendStatus`), `tasks/cancel` stops it (`conversations.stop`, needing
 * `write` as `conversation_stop` does), `tasks/update` acknowledges (no send waits for input through a task yet, so every
 * key is one not outstanding, which the extension says to ignore). Each needs the extension declared on its request
 * (else -32021) and a task id goblin made whose send the caller reaches now (else -32602).
 */
export function taskMethods(server: McpServer, power: Power, call: OwnerCaller, home: Home): void {
  if (!offers(power, 'conversations.sendStatus')) return
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } })
  /** The task an id names, for a request that declared the extension, and its workspace as the caller names it. */
  const routed = (taskId: string, ctx: unknown) => {
    if (!callContextOf(ctx).tasks) throw notDeclared()
    const ref = taskRefOf(taskId)
    if (ref === undefined) throw unknownTask()
    let reached: string
    try {
      reached = home(ref.workspace)
    } catch {
      // expected: a workspace the caller does not reach (any more) holds no task of theirs.
      throw unknownTask()
    }
    if (reached !== ref.workspace) throw unknownTask()
    return ref
  }
  const status = async (ref: TaskRef) => {
    try {
      return await call(
        (api) => api.conversations.sendStatus({ params: { id: ref.chat, operationId: ref.operationId } }),
        ref.workspace,
      )
    } catch (cause) {
      throw methodError(cause)
    }
  }
  server.server.setRequestHandler('tasks/get', { params: TaskParams }, async ({ taskId }, ctx) => {
    const ref = routed(taskId, ctx)
    return taskOf(taskId, ref, await status(ref), Date.now())
  })
  server.server.setRequestHandler('tasks/update', { params: UpdateParams }, async ({ taskId }, ctx) => {
    await status(routed(taskId, ctx))
    return {}
  })
  server.server.setRequestHandler('tasks/cancel', { params: TaskParams }, async ({ taskId }, ctx) => {
    const ref = routed(taskId, ctx)
    try {
      await call(
        (api) => api.conversations.stop({ params: { id: ref.chat }, payload: { operationId: ref.operationId } }),
        ref.workspace,
      )
    } catch (cause) {
      throw methodError(cause)
    }
    return {}
  })
}
