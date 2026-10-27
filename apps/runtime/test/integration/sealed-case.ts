import { TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { BOUNDARY_TEXT, POWER_TEXT } from '../../src/pi/asker.ts'
import { callOwner } from '../owner-client.ts'
import { type Person, type Server, asServer, lever, person, scriptApp, showing, signedIn } from './owner-requests.ts'
import { until, waitFor } from './until.ts'

const Seen = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      systemPrompt: Schema.String,
      tools: Schema.Array(Schema.String),
      context: Schema.optional(Schema.String),
    }),
  ),
})
type Request = (typeof Seen.Type)['requests'][number]

/** A Topic a server makes, with nothing in its setup. */
async function serverTopic(base: string, server: Server, name: string): Promise<TopicView> {
  const made = await asServer(base, server, 'POST', '/api/topics', { name, operationId: `svc:${name}` })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(TopicView)(await made.json())
}

/**
 * Every model request of a turn the agent made so far, oldest first: a turn's requests are goblin's, the memory's and
 * the rerank's (which quote the turn's words too) are not.
 */
const seen = async (base: string, owner: Person) =>
  Schema.decodeUnknownSync(Seen)(await (await lever(base, owner, 'queue/seen')).json()).requests.filter((request) =>
    request.systemPrompt.includes('You are goblin'),
  )

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

/**
 * The tool result the scripted model read back after the call `words` asked for: in the newest request that holds the
 * message, the first tool result after it (a request holds the chat's earlier results too).
 */
const resultAfter = async (base: string, owner: Person, words: string): Promise<string> => {
  const after = (requests: readonly Request[]) => {
    for (const request of requests.toReversed()) {
      const asked = request.messages.findLastIndex((message) => message.role === 'user' && message.text.includes(words))
      if (asked !== -1) return request.messages.slice(asked).find((message) => message.role === 'toolResult')?.text
    }
    return undefined
  }
  const requests = await until(
    () => seen(base, owner),
    (all) => after(all) !== undefined,
    10_000,
  )
  const found = after(requests)
  if (found === undefined)
    throw new Error(
      `no result of ${words}; the last requests: ${JSON.stringify(requests.slice(-3).map((request) => request.messages.slice(-3)))}`,
    )
  return found
}

/**
 * ADR 0115 on the real Worker and agent: every Topic is sealed and Personal is the hub, and what a turn may do is its
 * sender's power. An installed app makes two customer Topics: each one's search and automatic retrieval never reach the
 * other's words while the hub's do, an owner's sealed Topic cannot see either, an app's message is marked as the
 * server's, one customer's file is not found from the other, the Shared folder is the owner's turn's and never the
 * server's, and renaming the other customer from one is refused while the hub renames it. A `write` app is never
 * offered `routine_propose`, a call a stale filter still let through is refused at call time, and the next turn after
 * a restart has the filter again.
 */
export async function sealedCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  // The owner's own request gives the agent resident authority, which an app's turns still need.
  await callOwner(me, (api) => api.personas.list({ query: {} }))
  const server = await scriptApp(url, owner, 'sealed', { lists: true })
  const a = await serverTopic(url, server, 'Customer A')
  const b = await serverTopic(url, server, 'Customer B')
  expect([a.reach, b.reach, a.madeBy]).toEqual(['sealed', 'sealed', { app: 'sealed' }])
  const serverSays = async (topic: TopicView, input: string, operationId: string) => {
    const path = `/api/conversations/${topic.conversation}/messages`
    const sent = await asServer(url, server, 'POST', path, runInput(topic.conversation, { input, operationId }))
    expect(sent.status, await sent.clone().text()).toBe(202)
  }
  const ownerSays = (chat: string, input: string, operationId: string) =>
    callOwner(me, (api) =>
      api.conversations.submit({ params: { id: chat }, payload: runInput(chat, { input, operationId }) }),
    )

  // Each customer's words, said by the server; its message is marked as the server's.
  await serverSays(a, 'the plum harvest in the orchard is due', 'svc:a:1')
  const first = await requestFor(url, owner, 'the plum harvest in the orchard is due')
  expect(first.messages.findLast((message) => message.role === 'user')?.text.startsWith('[from server sealed]\n')).toBe(
    true,
  )
  // A manage app without the routines extra is not offered routines, nor apps outside the hub.
  expect(first.tools).not.toContain('routine_propose')
  expect(first.tools).not.toContain('app_call')
  await serverSays(b, 'the walnut delivery is on friday', 'svc:b:1')
  await showing(me, b.conversation, 'echo: the walnut delivery is on friday')

  // From A, B's words are never found, by search or automatic retrieval, and B is not even a Topic to name.
  await serverSays(a, 'call search_chats {"query":"walnut delivery"}', 'svc:a:2')
  expect(await resultAfter(url, owner, 'call search_chats {"query":"walnut delivery"}')).toContain(
    'No earlier messages matched',
  )
  await serverSays(a, 'call search_chats {"query":"walnut","topic":"Customer B"}', 'svc:a:3')
  expect(await resultAfter(url, owner, '"topic":"Customer B"')).toContain('That Topic was not found')
  await serverSays(a, 'pick-sources what about the walnut delivery on friday', 'svc:a:4')
  const fromA = await requestFor(url, owner, 'pick-sources what about the walnut delivery')
  expect(fromA.context ?? '').not.toContain('walnut delivery is on friday')

  // Personal, the hub, reaches both: its search and its automatic retrieval.
  await ownerSays('1', 'call search_chats {"query":"walnut delivery"}', 'own:1')
  expect(await resultAfter(url, owner, 'call search_chats {"query":"walnut delivery"}')).toContain('Quoted history')
  await ownerSays('1', 'what did we plan for the plum harvest in the orchard pick-sources', 'own:2')
  const hub = await requestFor(url, owner, 'plum harvest in the orchard pick-sources')
  expect(hub.context ?? '').toContain('orchard is due')

  // An owner's own Topic is sealed too: it cannot see A.
  const garden = await callOwner(me, (api) =>
    api.topics.create({ payload: { name: 'Garden', operationId: 'own:garden' } }),
  )
  await ownerSays(garden.conversation, 'call search_chats {"query":"plum orchard"}', 'own:3')
  expect(await resultAfter(url, owner, 'call search_chats {"query":"plum orchard"}')).toContain(
    'No earlier messages matched',
  )

  // Files (ADR 0115): A's agent keeps a file in A's own folder, which B cannot read; the Shared folder is readable on
  // the owner's turn in A, never on the server's.
  const shared = await me.fetch(
    new Request('https://agent/api/files/content?path=/uploads/shared-plan.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'the shared plan is ready',
    }),
  )
  expect(shared.status, await shared.clone().text()).toBe(201)
  await serverSays(a, 'call files_write {"path":"orders.md","content":"plum orders"}', 'svc:a:files:1')
  const kept = `/topics/${String(a.id)}/agent/orders.md`
  expect(await resultAfter(url, owner, '"path":"orders.md"')).toContain(kept)
  await serverSays(b, `call files_read {"path":"${kept}"}`, 'svc:b:files:1')
  expect(await resultAfter(url, owner, `call files_read {"path":"${kept}"}`)).toContain('NotFound')
  await serverSays(a, 'call files_read {"path":"/uploads/shared-plan.txt"}', 'svc:a:files:2')
  expect(await resultAfter(url, owner, 'call files_read {"path":"/uploads/shared-plan.txt"}')).toContain('NotFound')
  await ownerSays(a.conversation, 'call files_read {"path":"/uploads/shared-plan.txt"}', 'own:files:1')
  expect(await resultAfter(url, owner, 'call files_read {"path":"/uploads/shared-plan.txt"}')).toContain(
    'the shared plan is ready',
  )

  // Renaming B from A is acting on another Topic: refused, and B keeps its name. From the hub it is renamed.
  await serverSays(a, 'call topic_rename {"topic":"Customer B","name":"Taken over"}', 'svc:a:5')
  expect(await resultAfter(url, owner, '"name":"Taken over"')).toContain(BOUNDARY_TEXT.slice(0, 40))
  expect((await callOwner(me, (api) => api.topics.get({ params: { id: b.id } }))).name).toBe('Customer B')
  await ownerSays('1', 'call topic_rename {"topic":"Customer B","name":"Customer B2"}', 'own:4')
  await waitFor(
    () => callOwner(me, (api) => api.topics.get({ params: { id: b.id } })),
    (topic) => topic.name === 'Customer B2',
    'B renamed from the hub',
    10_000,
  )

  // The owner writing in A works with the owner's power there, within A: routines, not the hub's Source tools.
  await ownerSays(a.conversation, 'the owner looks in', 'own:5')
  const ownerInA = await requestFor(url, owner, 'the owner looks in')
  expect(ownerInA.tools).toContain('routine_propose')
  expect(ownerInA.tools).not.toContain('source_route')

  // A write app is never offered routine_propose; a filter that still offers it (stored before, or stale) is
  // refused at call time, and the next turn after a restart has the filter again.
  const writer = await scriptApp(url, owner, 'writer', { level: 'write' })
  const mine = await serverTopic(url, writer, 'Customer W')
  const writes = async (input: string, operationId: string) => {
    const path = `/api/conversations/${mine.conversation}/messages`
    const sent = await asServer(url, writer, 'POST', path, runInput(mine.conversation, { input, operationId }))
    expect(sent.status, await sent.clone().text()).toBe(202)
  }
  await writes('hello from the writer', 'svc:w:1')
  expect((await requestFor(url, owner, 'hello from the writer')).tools).not.toContain('routine_propose')
  expect((await lever(url, owner, 'power/stale', { chat: mine.conversation })).status).toBe(200)
  const propose = `call routine_propose ${JSON.stringify({
    title: 'Nightly',
    trigger: { kind: 'cron', expression: '0 2 * * *' },
    timezone: 'UTC',
    tellMe: { on: true, copy: false },
    handTo: { kind: 'none' },
  })}`
  await writes(propose, 'svc:w:2')
  expect((await requestFor(url, owner, 'call routine_propose')).tools).toContain('routine_propose')
  expect(await resultAfter(url, owner, 'call routine_propose')).toContain(POWER_TEXT.slice(0, 40))
  await lever(url, owner, 'power/restart', {})
  await writes('after the restart', 'svc:w:3')
  expect((await requestFor(url, owner, 'after the restart')).tools).not.toContain('routine_propose')
}
