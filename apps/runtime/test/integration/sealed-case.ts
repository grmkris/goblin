import { TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { BOUNDARY_TEXT, POWER_TEXT } from '../../src/pi/asker.ts'
import { callOwner } from '../owner-client.ts'
import { type Person, call, keyBody, lever, ownerFetch, person, showing, signedIn } from './owner-requests.ts'
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

/** A key of `who` for a server (ADR 0081) named `name`, with `terms` as its grant (ADR 0114). Its secret. */
async function keyOf(base: string, who: Person, name: string, terms: Parameters<typeof keyBody>[2]): Promise<string> {
  const made = await call(base, who, '/api/keys', keyBody(who, name, terms))
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

/** A Topic a key makes, with nothing in its setup. */
async function keyTopic(base: string, secret: string, name: string): Promise<TopicView> {
  const made = await asKey(base, secret, 'POST', '/api/topics', { name, operationId: `svc:${name}` })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(TopicView)(await made.json())
}

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

/** The tool result the scripted model read back after the call `words` asked for. */
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
 * ADR 0115 on the real Worker and agent: every Topic is sealed and Personal is the hub, and what a turn may do is its
 * sender's power. A server's key makes two customer Topics: each one's search and automatic retrieval never reach the
 * other's words while the hub's do, an owner's sealed Topic cannot see either, a key's message is marked as the
 * server's, and renaming the other customer from one is refused while the hub renames it. A `write` key is never
 * offered `routine_propose`, a call a stale filter still let through is refused at call time, and the next turn after
 * a restart has the filter again.
 */
export async function sealedCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  // The owner's own request gives the agent resident authority, which a key's turns still need.
  await callOwner(me, (api) => api.personas.list({ query: {} }))
  const secret = await keyOf(url, owner, 'sealed', { lists: true })
  const a = await keyTopic(url, secret, 'Customer A')
  const b = await keyTopic(url, secret, 'Customer B')
  expect([a.reach, b.reach, a.madeBy]).toEqual(['sealed', 'sealed', { key: 'sealed' }])
  const keySays = async (topic: TopicView, input: string, operationId: string) => {
    const path = `/api/conversations/${topic.conversation}/messages`
    const sent = await asKey(url, secret, 'POST', path, runInput(topic.conversation, { input, operationId }))
    expect(sent.status, await sent.clone().text()).toBe(202)
  }
  const ownerSays = (chat: string, input: string, operationId: string) =>
    callOwner(me, (api) =>
      api.conversations.submit({ params: { id: chat }, payload: runInput(chat, { input, operationId }) }),
    )

  // Each customer's words, said by the server; its message is marked as the server's.
  await keySays(a, 'the plum harvest in the orchard is due', 'svc:a:1')
  const first = await requestFor(url, owner, 'the plum harvest in the orchard is due')
  expect(first.messages.findLast((message) => message.role === 'user')?.text.startsWith('[from server sealed]\n')).toBe(
    true,
  )
  // A manage key without the routines extra is not offered routines, nor apps outside the hub.
  expect(first.tools).not.toContain('routine_propose')
  expect(first.tools).not.toContain('app_call')
  await keySays(b, 'the walnut delivery is on friday', 'svc:b:1')
  await showing(me, b.conversation, 'echo: the walnut delivery is on friday')

  // From A, B's words are never found, by search or automatic retrieval, and B is not even a Topic to name.
  await keySays(a, 'call search_chats {"query":"walnut delivery"}', 'svc:a:2')
  expect(await resultAfter(url, owner, 'call search_chats {"query":"walnut delivery"}')).toContain(
    'No earlier messages matched',
  )
  await keySays(a, 'call search_chats {"query":"walnut","topic":"Customer B"}', 'svc:a:3')
  expect(await resultAfter(url, owner, '"topic":"Customer B"')).toContain('That Topic was not found')
  await keySays(a, 'pick-sources what about the walnut delivery on friday', 'svc:a:4')
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

  // Renaming B from A is acting on another Topic: refused, and B keeps its name. From the hub it is renamed.
  await keySays(a, 'call topic_rename {"topic":"Customer B","name":"Taken over"}', 'svc:a:5')
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

  // A write key is never offered routine_propose; a filter that still offers it (stored before, or stale) is
  // refused at call time, and the next turn after a restart has the filter again.
  const writer = await keyOf(url, owner, 'writer', { level: 'write' })
  const mine = await keyTopic(url, writer, 'Customer W')
  const writes = async (input: string, operationId: string) => {
    const path = `/api/conversations/${mine.conversation}/messages`
    const sent = await asKey(url, writer, 'POST', path, runInput(mine.conversation, { input, operationId }))
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
