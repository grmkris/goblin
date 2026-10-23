import { TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { ROOM_TOOLS, roomAllows } from '../../src/pi/room.ts'
import { callOwner } from '../owner-client.ts'
import { type Person, call, lever, ownerFetch, person, showing, signedIn, workspaceOf } from './owner-requests.ts'
import { ownerResult } from './probe-reads.ts'
import { waitFor } from './until.ts'

const Secret = Schema.Struct({ secret: Schema.String })
const Seen = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      tools: Schema.Array(Schema.String),
      context: Schema.optional(Schema.String),
    }),
  ),
})
type Request = (typeof Seen.Type)['requests'][number]

/** The fixture server the owner connected, which the key may give its room (ADR 0081). */
const FIXTURE = 'apps-fixture'

/** A message that has the scripted model call `name` of the fixture with `args`. */
const fixtureCall = (name: string, args: Record<string, unknown> = {}) =>
  `call mcp_call ${JSON.stringify({ connectionId: FIXTURE, name, arguments: args })}`

/** What the owner keeps under received files, as listed; empty while the folder is not there yet. */
const received = async (me: ReturnType<typeof signedIn>) => {
  const listed = await ownerResult(me, (api) => api.files.list({ query: { dir: '/agent/received' } }))
  return listed.ok ? JSON.stringify(listed.value) : ''
}

/** Tools an owner's chat has that a room must never offer: one of each kind the room leaves out. */
const DENIED = ['files_list', 'files_write', 'code_run', 'topic_create', 'persona_update', 'routine_propose']

/** A key of `who` for a server (ADR 0081), named `rooms`, as the owner makes it in Settings: its secret. */
async function keyOf(base: string, who: Person): Promise<string> {
  const made = await call(base, who, '/api/keys', {
    name: 'rooms',
    scopes: ['topics', 'conversations', 'personas'],
    servers: [FIXTURE],
    expiresInDays: 1,
  })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Secret)(await made.json()).secret
}

/** One request of a server with `secret`: no cookie, no Origin, a JSON body when there is one. */
const asKey = (base: string, secret: string, method: string, path: string, body?: unknown) =>
  ownerFetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Every model request the agent made so far, oldest first. */
const seen = async (base: string, owner: Person) =>
  Schema.decodeUnknownSync(Seen)(await (await lever(base, owner, 'queue/seen')).json()).requests

/** The newest model request whose newest user message holds `words`, waited for. */
const requestFor = async (base: string, owner: Person, words: string): Promise<Request> => {
  const holds = (request: Request) =>
    request.messages.findLast((message) => message.role === 'user')?.text.includes(words) === true
  const requests = await waitFor(
    () => seen(base, owner),
    (all) => all.some(holds),
    `a model request for ${words}`,
    10_000,
  )
  const found = requests.findLast(holds)
  if (found === undefined) throw new Error(`no request for ${words}`)
  return found
}

/** The tool result the scripted model read back after the call `words` asked for: its `done: …` answer's source. */
const resultAfter = async (base: string, owner: Person, words: string): Promise<string> => {
  const after = (requests: readonly Request[]) => {
    const at = requests.findLastIndex((request) =>
      request.messages.some((message) => message.role === 'user' && message.text.includes(words)),
    )
    return requests
      .slice(at)
      .flatMap((request) => request.messages.filter((message) => message.role === 'toolResult'))
      .at(-1)?.text
  }
  const requests = await waitFor(
    () => seen(base, owner),
    (all) => after(all) !== undefined,
    `the result of ${words}`,
    10_000,
  )
  return after(requests) ?? ''
}

/**
 * ADR 0108 on the real Worker and agent: a key's Topic is a room. A key makes one and writes in it: the model is offered
 * only the room's tools and reads the message as the server's, with the room's block in its context; a tool a stale
 * filter still offers is refused at call time, and the next turn after a restart has the filter again; `search_chats`
 * reaches no other Topic from it, and the owner's automatic retrieval never brings its words into their chats. Every
 * tool an owner's chat is offered is one a room offers or one it never does.
 */
export async function roomsCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  // The owner's own request gives the agent resident authority, which a key's turns still need.
  await callOwner(me, (api) => api.personas.list({ query: {} }))
  await callOwner(me, (api) => api.mcp.connect({ params: { id: FIXTURE }, payload: {} }))
  await callOwner(me, (api) =>
    api.mcp.setToolGrant({ payload: { connectionId: FIXTURE, name: 'board', allowed: true } }),
  )
  const secret = await keyOf(url, owner)
  const made = await asKey(url, secret, 'POST', '/api/topics', {
    name: 'Customer 9',
    operationId: 'svc:topic:9',
    setup: {
      mcpServers: [{ connectionId: FIXTURE, tools: ['board'] }],
      skills: [],
      apps: [],
      subagents: false,
    },
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const room = Schema.decodeUnknownSync(TopicView)(await made.json())
  expect(room.room).toEqual({ key: 'rooms' })
  const say = async (input: string, operationId: string) => {
    const sent = await asKey(
      url,
      secret,
      'POST',
      `/api/conversations/${room.conversation}/messages`,
      runInput(room.conversation, { input, operationId }),
    )
    expect(sent.status, await sent.clone().text()).toBe(202)
  }

  // The room's turn: offered only the room's tools, the server's words marked as its, the room's block in context.
  await say('the plum harvest in the orchard is due', 'svc:msg:1')
  const first = await requestFor(url, owner, 'the plum harvest in the orchard is due')
  const asked = first.messages.findLast((message) => message.role === 'user')?.text ?? ''
  expect(asked.startsWith('[from server rooms]\n')).toBe(true)
  expect(first.tools.filter((tool) => !roomAllows(tool))).toEqual([])
  expect(first.tools).toEqual(expect.arrayContaining(['mcp_list', 'mcp_call', 'skill_activate', 'ask_user']))
  expect(first.context).toContain('You reach only this room')
  await showing(me, room.conversation, 'echo: the plum harvest in the orchard is due')

  // The owner's main: every tool it is offered is one a room offers too, or one the room was not offered.
  const mine = 'what did we plan for the plum harvest in the orchard pick-sources'
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: runInput('1', { input: mine, operationId: 'own:msg:1' }),
    }),
  )
  const owners = await requestFor(url, owner, mine)
  const denied = owners.tools.filter((tool) => !roomAllows(tool))
  expect(denied).toEqual(expect.arrayContaining(DENIED))
  expect(denied.filter((tool) => first.tools.includes(tool))).toEqual([])
  expect(owners.tools.filter((tool) => ROOM_TOOLS.has(tool))).toEqual(
    expect.arrayContaining(['mcp_list', 'mcp_call', 'skill_activate', 'ask_user']),
  )
  // Its automatic retrieval never brings a room's words: no candidate from the room reached the rerank or the context.
  expect(owners.context ?? '').not.toContain('orchard is due')

  // From the room, search_chats reaches no other Topic.
  await say('call search_chats {"query":"plum","topic":"Personal"}', 'svc:msg:2')
  expect(await resultAfter(url, owner, 'call search_chats')).toContain('That Topic was not found')

  // A filter stored before rooms (or before a deploy) still offers a denied tool: the guard refuses it at call time.
  expect((await lever(url, owner, 'rooms/stale', { chat: room.conversation })).status).toBe(200)
  await say('call files_list {"dir":"/agent"}', 'svc:msg:3')
  const stale = await requestFor(url, owner, 'call files_list')
  expect(stale.tools).toContain('files_list')
  expect(await resultAfter(url, owner, 'call files_list')).toContain('This chat is a room')

  // After a restart, the room's first turn puts its filter right again before the model is asked.
  await lever(url, owner, 'rooms/restart', {})
  await say('after the restart', 'svc:msg:4')
  const restarted = await requestFor(url, owner, 'after the restart')
  expect(restarted.tools.filter((tool) => !roomAllows(tool))).toEqual([])

  // ADR 0113: a room's MCP call keeps nothing of the owner's, no App and no file, though the model reads its result.
  await say(fixtureCall('board', { marker: 'room' }), 'svc:msg:5')
  expect(await resultAfter(url, owner, fixtureCall('board', { marker: 'room' }))).toContain('fixture-board')
  await say(fixtureCall('board', { clip: true }), 'svc:msg:6')
  expect(await resultAfter(url, owner, fixtureCall('board', { clip: true }))).toContain('"clip":true')
  const apps = (await workspaceOf(url, owner)).apps
  expect(apps.filter((app) => app.conversation === room.conversation)).toEqual([])
  expect(await received(me)).not.toContain(FIXTURE)
  // The same calls from the owner's own chat keep the App and the file, as they always did (ADRs 0020, 0065).
  const thread = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  const ownCall = (input: string, operationId: string) =>
    callOwner(me, (api) =>
      api.conversations.submit({ params: { id: thread.id }, payload: runInput(thread.id, { input, operationId }) }),
    )
  await ownCall(fixtureCall('board', { marker: 'owner' }), 'own:fixture:1')
  const kept = await waitFor(
    () => workspaceOf(url, owner),
    (workspace) => workspace.apps.some((app) => app.conversation === thread.id),
    "the owner's App kept",
    10_000,
  )
  expect(kept.apps.filter((app) => app.conversation === room.conversation)).toEqual([])
  await ownCall(fixtureCall('board', { clip: true }), 'own:fixture:2')
  await waitFor(
    () => received(me),
    (listed) => listed.includes(FIXTURE),
    "the owner's file kept",
    10_000,
  )
}
