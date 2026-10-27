/**
 * The integrator paths, as a product and an MCP client use them after a deploy (ADR 0128): the signed-in person
 * registers a fresh app and installs it through the install page's API (its redirect, and a decline's), the app's
 * `client_credentials` token works on the workspace's REST paths, its stream and Events (ADRs 0116, 0118, 0112), an MCP
 * client connects through OAuth consent and sends the one model turn of the deploy as a Task (ADR 0119), and the
 * refusals hold. The app is deleted and the client revoked whatever failed.
 */
import { randomBytes } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { presetFor } from '../packages/contracts/src/grants.ts'
import { TopicView } from '../packages/contracts/src/topics.ts'
import type { DevClient } from './smoke-client.ts'
import { InboundClient, base64url, operationId } from './smoke-inbound.ts'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const object = Schema.decodeUnknownSync(ObjectSchema)
const string = Schema.decodeUnknownSync(Schema.String)

/** Where the install sends the person back: any https address of the app's own; the smoke never follows it. */
const RETURN_URL = 'https://example.com/goblin-smoke/installed'
/** The one model turn of a deploy (ADR 0128), and the word its answer must hold. */
export const PONG_INPUT = 'Reply with the single word: pong'
const PONG = /\bpong\b/iu
const TURN_MS = 150_000
const POLL_MS = 2_000

export type IntegratorReport = {
  readonly app: 'registered'
  readonly install: 'redirected'
  readonly decline: 'access_denied'
  readonly token: 'client_credentials'
  readonly rest: 'ok'
  readonly stream: 'ok'
  readonly events: number
  readonly mcp: 'ok'
  readonly task: 'completed'
  readonly turn: 'pong'
  readonly refusals: 'ok'
}

/** The query of a redirect the install answered, checked against what it must carry; `''` when it does. */
export function redirectMismatch(redirect: string | undefined, expected: Readonly<Record<string, string>>): string {
  if (redirect === undefined) return 'no redirect'
  const url = new URL(redirect)
  if (`${url.origin}${url.pathname}` !== RETURN_URL) return 'redirect elsewhere'
  const wrong = Object.entries(expected).filter(([key, value]) => url.searchParams.get(key) !== value)
  return wrong.length === 0 ? '' : `redirect ${wrong.map(([key]) => key).join(', ')}`
}

/** Each `data:` frame's event type, read until one of `until` or the end of the body. */
async function eventTypes(body: ReadableStream<Uint8Array>, until: ReadonlySet<string>): Promise<string[]> {
  const types: string[] = []
  const decoder = new TextDecoder()
  let pending = ''
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return types
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const type = string(object(JSON.parse(line.slice('data: '.length)))['type'])
        types.push(type)
        if (until.has(type)) return types
      }
    }
  } finally {
    // expected: letting go of a stream that already ended or failed has nothing left to report
    await reader.cancel().catch(() => undefined)
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The app's own requests: its token as the bearer, no cookie and no CSRF header, as a server sends them. */
function appRequests(dev: DevClient, token: string) {
  return (path: string, init: { method?: string; body?: unknown; workspace?: boolean; accept?: string } = {}) =>
    dev.send(path, {
      method: init.method ?? 'GET',
      owner: false,
      csrf: false,
      workspace: init.workspace ?? true,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.accept === undefined ? {} : { accept: init.accept }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
}

async function appToken(dev: DevClient, clientId: string, secret: string): Promise<string> {
  const basic = Buffer.from(`${clientId}:${secret}`).toString('base64')
  const answer = await dev.send('/api/auth/oauth2/token', {
    method: 'POST',
    owner: false,
    csrf: false,
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: `${dev.origin}/mcp`,
      scope: 'goblin',
    }).toString(),
  })
  if (answer.status !== 200) throw new Error(`app_token_refused: ${answer.status}`)
  return string(object(await answer.json())['access_token'])
}

/** The task a send became, followed with `tasks/get` until it is no longer working; its last read. */
async function followTask(client: InboundClient, taskId: string): Promise<JsonObject> {
  const deadline = Date.now() + TURN_MS
  for (;;) {
    const got = await client.modern('tasks/get', { taskId }, { tasks: true, name: taskId })
    if (got.error !== undefined) throw new Error(`task_get_failed: ${JSON.stringify(got.error['code'] ?? null)}`)
    const result = got.result ?? {}
    if (result['status'] !== 'working' || Date.now() > deadline) return result
    await wait(POLL_MS)
  }
}

/** An MCP client of the person's, connected by consent: its tools, and the deploy's one turn sent as a Task. */
async function mcpChecks(dev: DevClient, chat: string): Promise<{ readonly answered: string }> {
  const client = await InboundClient.register(dev)
  try {
    await client.authorize()
    const listed = await client.rpc('tools/list')
    const names = (Array.isArray(listed.result?.['tools']) ? listed.result['tools'] : []).map(
      (tool) => object(tool)['name'],
    )
    if (
      !['conversation_send', 'conversation_send_status', 'conversation_entries'].every((name) => names.includes(name))
    )
      throw new Error('mcp_tools_missing')
    const sent = await client.modern(
      'tools/call',
      {
        name: 'conversation_send',
        arguments: { chat, message: { input: PONG_INPUT, operationId: operationId('pong') } },
      },
      { tasks: true, name: 'conversation_send' },
    )
    if (sent.result?.['resultType'] !== 'task') throw new Error('mcp_send_not_a_task')
    const taskId = string(sent.result['taskId'])
    const without = await client.modern('tasks/get', { taskId }, { tasks: false, name: taskId })
    if (without.error?.['code'] !== -32021) throw new Error('task_extension_not_required')
    const done = await followTask(client, taskId)
    if (done['status'] !== 'completed') throw new Error(`task_not_completed: ${JSON.stringify(done['status'] ?? null)}`)
    return { answered: JSON.stringify(done['result'] ?? {}) }
  } finally {
    // expected: the step list records the revoke's answer; a refusal here must not hide a failure above
    await dev.person((api) => api.clients.revoke({ params: { clientId: client.clientId } })).catch(() => undefined)
  }
}

/** The installed app's checks, run with its token: REST, the stream and Events around the deploy's one turn. */
async function appChecks(
  dev: DevClient,
  token: string,
): Promise<Omit<IntegratorReport, 'app' | 'install' | 'decline'>> {
  const app = appRequests(dev, token)
  if ((await app('/api/access')).status !== 200) throw new Error('app_access_unread')
  const name = `smoke ${new Date().toISOString().slice(0, 16)} ${base64url(randomBytes(3))}`
  const made = await app('/api/topics', { method: 'POST', body: { name, operationId: operationId('topic') } })
  if (made.status !== 201) throw new Error(`app_topic_refused: ${made.status}`)
  const topic = Schema.decodeUnknownSync(TopicView)(await made.json())
  const chat = topic.conversation
  const listed = await app('/api/topics')
  if (listed.status !== 200 || !(await listed.text()).includes(name)) throw new Error('app_topic_not_listed')
  const polled = await app('/api/events/poll', {
    method: 'POST',
    body: { name: 'conversation.updated', arguments: { chat }, cursor: null },
  })
  if (polled.status !== 200) throw new Error(`app_events_refused: ${polled.status}`)
  const cursor = string(object(await polled.json())['cursor'])
  const stream = await app(`/api/conversations/${chat}/stream`, { accept: 'text/event-stream' })
  if (stream.status !== 200 || stream.body === null) throw new Error(`app_stream_refused: ${stream.status}`)
  const reading = eventTypes(stream.body, new Set(['RUN_FINISHED', 'RUN_ERROR']))
  const { answered } = await mcpChecks(dev, chat)
  const types = await Promise.race([reading, wait(TURN_MS).then(() => ['timeout'])])
  if (types[0] !== 'MESSAGES_SNAPSHOT' || !types.includes('RUN_FINISHED')) throw new Error('app_stream_missed_the_turn')
  if (!PONG.test(answered)) throw new Error('turn_not_pong')
  const after = await app('/api/events/poll', {
    method: 'POST',
    body: { name: 'conversation.updated', arguments: { chat }, cursor },
  })
  const page = after.status === 200 ? object(await after.json()) : {}
  const count = Array.isArray(page['events']) ? page['events'].length : 0
  if (count === 0) throw new Error('app_events_missed_the_turn')
  // What the app never reaches: another workspace, the bare paths a key used, and the people's member list.
  const refused = [
    (await app('/w/smoke-no-such-workspace/api/topics', { workspace: false })).status === 404,
    (await app('/api/topics', { workspace: false })).status === 404,
    (await app('/api/members')).status === 403,
  ]
  if (!refused.every(Boolean)) throw new Error('app_refusals_failed')
  await dev.owner((api) => api.topics.update({ params: { id: topic.id }, payload: { archived: true } }))
  return {
    token: 'client_credentials',
    rest: 'ok',
    stream: 'ok',
    events: count,
    mcp: 'ok',
    task: 'completed',
    turn: 'pong',
    refusals: 'ok',
  }
}

/** Registers a fresh app, installs and declines it, runs its checks and the MCP checks, then deletes it. */
export async function integratorChecks(dev: DevClient): Promise<IntegratorReport> {
  const terms = presetFor(`goblin smoke ${base64url(randomBytes(4))}`, [dev.workspaceId])
  const registered = await dev.account((api) =>
    api.developerApps.register({ payload: { name: terms.name, returnUrls: [RETURN_URL], terms } }),
  )
  const { clientId } = registered.app
  try {
    await dev.person((api) => api.install.info({ params: { clientId } }))
    const state = base64url(randomBytes(12))
    const approved = await dev.person((api) =>
      api.install.approve({
        params: { clientId },
        payload: { workspace: dev.workspaceId, terms, state, returnUrl: RETURN_URL },
      }),
    )
    const installed = redirectMismatch(approved.redirect, {
      installation: approved.installation.id,
      workspace: dev.slug,
      state,
    })
    if (installed !== '') throw new Error(`install_${installed.replaceAll(' ', '_')}`)
    const declined = await dev.person((api) =>
      api.install.decline({ params: { clientId }, payload: { state, returnUrl: RETURN_URL } }),
    )
    const decline = redirectMismatch(declined.redirect, { error: 'access_denied', state })
    if (decline !== '') throw new Error(`decline_${decline.replaceAll(' ', '_')}`)
    const token = await appToken(dev, clientId, registered.clientSecret)
    const checks = await appChecks(dev, token)
    return { app: 'registered', install: 'redirected', decline: 'access_denied', ...checks }
  } finally {
    // expected: deleting the app ends its installation; a refusal here must not hide a failure above
    await dev.account((api) => api.developerApps.delete({ params: { clientId } })).catch(() => undefined)
  }
}
