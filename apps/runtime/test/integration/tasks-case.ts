import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { TASKS_EXTENSION } from '../../src/inbound/access.ts'
import { taskIdOf, taskRefOf } from '../../src/inbound/tasks.ts'
import { ALL_SCOPES, authorize, register } from './auth-inspect.ts'
import { call, holding, person } from './owner-requests.ts'

const REVISION = '2026-07-28'
const Answer = Schema.Struct({
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
type Answer = typeof Answer.Type

/** The JSON-RPC answer a `/mcp` response carries: its body, or the last `data:` frame of a server-sent one. */
async function answerOf(response: Response): Promise<Answer> {
  const body = await response.text()
  const json =
    response.headers.get('content-type')?.includes('text/event-stream') === true
      ? (body
          .split('\n')
          .findLast((line) => line.startsWith('data: '))
          ?.slice('data: '.length) ?? '{}')
      : body
  return Schema.decodeUnknownSync(Schema.fromJsonString(Answer))(json)
}

/**
 * One 2026-07-28 request of `/mcp` with `token`, by hand: the SDK's client refuses a result type it does not know, and
 * a task is one. Its envelope declares the Tasks extension when `tasks`; `name` is what `Mcp-Name` mirrors.
 */
const modern =
  (base: string, token: string) =>
  async (method: string, params: Record<string, unknown>, options: { tasks: boolean; name?: string }) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': REVISION,
        'mcp-method': method,
        ...(options.name === undefined ? {} : { 'mcp-name': options.name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: REVISION,
            [CLIENT_INFO_META_KEY]: { name: 'tasks-fixture', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: options.tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
          },
        },
      }),
    })
    return answerOf(response)
  }

/** Reads every 250 ms (a grant's requests are counted per minute) until `done` holds or `ms` pass; the last read. */
async function poll<A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 20_000): Promise<A> {
  const end = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    value = await read()
  }
  return value
}

/** A field of a result, as an unknown the test then checks. */
const field = (answer: Answer, name: string): unknown => answer.result?.[name]

/**
 * ADR 0119 on the real Worker and agent: a client that declares the Tasks extension gets a task from
 * `conversation_send` and follows it with `tasks/get` to the answer; one that does not gets the receipt, and
 * `conversation_send_status` tells it how the send stands; `tasks/cancel` stops a running send; `tasks/*` without the
 * extension, an id goblin never made, or one naming a workspace outside the client's reach, are refused.
 */
export async function tasksCase(base: string) {
  const owner = await person(base)
  // The owner's own request gives the agent resident authority, which a client's sends still need.
  expect((await call(base, owner, '/api/personas')).status).toBe(200)
  const clientId = await register(base, owner)
  const { access } = await authorize(base, owner, clientId, { scope: ALL_SCOPES, terms: { level: 'write' } })
  const rpc = modern(base, access)
  const send = (input: string, operationId: string, tasks: boolean) =>
    rpc(
      'tools/call',
      { name: 'conversation_send', arguments: { chat: '1', message: { input, operationId } } },
      { tasks, name: 'conversation_send' },
    )
  const get = (taskId: string, tasks = true) => rpc('tasks/get', { taskId }, { tasks, name: taskId })

  const created = await send('task hello', 'tasks-op-1', true)
  expect(created.result).toMatchObject({ resultType: 'task', status: 'working', pollIntervalMs: 2000 })
  const taskId = String(field(created, 'taskId'))
  const done = await poll(
    () => get(taskId),
    (answer) => field(answer, 'status') === 'completed',
  )
  expect(done.result).toMatchObject({
    taskId,
    status: 'completed',
    result: { content: [{ type: 'text', text: 'echo: task hello' }] },
  })

  // Without the extension: the receipt as before, its send's status by the tool, and no task methods.
  const plain = await send('plain hello', 'tasks-op-2', false)
  expect(field(plain, 'resultType')).toBe('complete')
  expect(field(plain, 'structuredContent')).toMatchObject({ operationId: 'tasks-op-2', accepted: true })
  const status = () =>
    rpc(
      'tools/call',
      { name: 'conversation_send_status', arguments: { chat: '1', operationId: 'tasks-op-2' } },
      { tasks: false, name: 'conversation_send_status' },
    )
  const answered = await poll(status, (answer) =>
    JSON.stringify(field(answer, 'structuredContent')).includes('answered'),
  )
  expect(field(answered, 'structuredContent')).toEqual({ status: 'answered', text: 'echo: plain hello' })
  expect((await get(taskId, false)).error?.code).toBe(-32021)
  expect((await get('t1.e30')).error?.code).toBe(-32602)
  const ref = taskRefOf(taskId)
  expect(ref).toBeDefined()
  if (ref !== undefined) expect((await get(taskIdOf({ ...ref, workspace: 'ws-elsewhere' }))).error?.code).toBe(-32602)

  // A send held mid-run works with its step, and cancelling it stops it: the task ends cancelled.
  const heldInput = 'queue-hold:tasks-cancel'
  const held = await send(heldInput, 'tasks-op-3', true)
  const heldId = String(field(held, 'taskId'))
  await holding(base, owner, heldInput)
  expect((await get(heldId)).result).toMatchObject({ status: 'working', statusMessage: 'thinking' })
  const cancelled = await rpc('tasks/cancel', { taskId: heldId }, { tasks: true, name: heldId })
  expect(cancelled.error).toBeUndefined()
  expect(
    (
      await poll(
        () => get(heldId),
        (answer) => field(answer, 'status') === 'cancelled',
      )
    ).result,
  ).toMatchObject({ status: 'cancelled' })
}
