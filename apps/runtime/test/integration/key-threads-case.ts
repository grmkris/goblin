import { ConversationEntries, StartedThread, TopicView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, call, ownerFetch, person, signedIn } from './owner-requests.ts'
import { ownerSnapshot } from './probe-reads.ts'

const Snapshot = Schema.Struct({
  entries: Schema.optional(Schema.Array(Schema.Struct({ kind: Schema.String, data: Schema.optional(Schema.Unknown) }))),
})
const Secret = Schema.Struct({ secret: Schema.String })
const Made = Schema.Struct({ id: Schema.Int })
const Refusal = Schema.Struct({ error: Schema.Struct({ reason: Schema.optional(Schema.String) }) })

/** A key of `who` with `scopes` (ADR 0081), as the owner makes it in Settings: its secret. */
async function keyOf(base: string, who: Person, scopes: readonly string[]): Promise<string> {
  const made = await call(base, who, '/api/keys', { name: 'threads', scopes, servers: [], expiresInDays: 1 })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Secret)(await made.json()).secret
}

/** One request of a server with `secret` to `path`: no cookie, no Origin, a JSON body when there is one. */
const asKey = (base: string, secret: string, method: string, path: string, body?: unknown) =>
  ownerFetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const reasonOf = async (response: Response) => Schema.decodeUnknownSync(Refusal)(await response.json()).error.reason

/**
 * ADR 0090 on the real Worker and agent: a key titles the empty threads it starts, which announce themselves in their
 * Topic's Conversation once; it renames, closes and reopens its own threads and no other chat; and the forward read
 * shows its message to a Persona as the owner's, with whom it went to.
 */
export async function keyThreadsCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  const secret = await keyOf(url, owner, ['topics', 'conversations', 'personas'])
  const other = await keyOf(url, owner, ['topics', 'conversations'])
  const topicOf = async (key: string, name: string, operationId: string) =>
    Schema.decodeUnknownSync(TopicView)(
      await (await asKey(url, key, 'POST', '/api/topics', { name, operationId })).json(),
    )
  const topic = await topicOf(secret, 'Customer 1', 'svc:topic:1')
  const otherTopic = await topicOf(other, 'Customer 2', 'svc:topic:2')
  const channel = topic.conversation
  const notes = async () =>
    (Schema.decodeUnknownSync(Snapshot)(await ownerSnapshot(me, channel)).entries ?? []).filter(
      (entry) => entry.kind === 'app.thread_started',
    )

  // A titled empty thread is named at once and announced in its Topic's Conversation once, also when replayed.
  const start = { operationId: 'svc:job:1', anchor: 'empty', title: 'Job 1', message: { input: 'start the job' } }
  const started = await asKey(url, secret, 'POST', `/api/conversations/${channel}/threads`, start)
  expect(started.status, await started.clone().text()).toBe(201)
  const { thread } = Schema.decodeUnknownSync(StartedThread)(await started.json())
  expect(thread).toMatchObject({ kind: 'thread', parent: channel, title: 'Job 1' })
  expect(await notes()).toEqual([{ kind: 'app.thread_started', data: { thread: thread.id } }])
  const replay = await asKey(url, secret, 'POST', `/api/conversations/${channel}/threads`, start)
  expect(Schema.decodeUnknownSync(StartedThread)(await replay.json()).thread.id).toBe(thread.id)
  expect(await notes()).toHaveLength(1)

  // An untitled empty thread owes its note until it is named; a rename (here the owner's) writes it, once.
  const untitled = { ...start, operationId: 'svc:agent:1', title: undefined }
  const plain = Schema.decodeUnknownSync(StartedThread)(
    await (await asKey(url, secret, 'POST', `/api/conversations/${channel}/threads`, untitled)).json(),
  ).thread
  const rename = (title: string) =>
    callOwner(me, (api) => api.conversations.update({ params: { id: plain.id }, payload: { title } }))
  await rename('Agent thread')
  await rename('Agent thread, renamed')
  expect((await notes()).filter((note) => JSON.stringify(note.data).includes(plain.id))).toHaveLength(1)

  // The key renames, closes and reopens its own thread; closing refuses a send and keeps the chat readable.
  const patch = (key: string, chat: string, change: unknown) =>
    asKey(url, key, 'PATCH', `/api/conversations/${chat}`, change)
  expect(await (await patch(secret, thread.id, { title: 'Job 1, done' })).json()).toMatchObject({
    title: 'Job 1, done',
  })
  expect((await patch(secret, thread.id, { closed: true })).status).toBe(200)
  const closedSend = await asKey(url, secret, 'POST', `/api/conversations/${thread.id}/messages`, {
    input: 'one more thing',
    operationId: 'svc:msg:closed',
  })
  expect(await reasonOf(closedSend)).toBe('conversation_closed')
  expect((await asKey(url, secret, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).status).toBe(200)
  expect((await patch(secret, thread.id, { closed: false })).status).toBe(200)

  // Nothing else: another key's chat, its Topic's Conversation, or pinning a chat open.
  expect((await patch(other, thread.id, { title: 'Mine now' })).status).toBe(404)
  expect((await patch(secret, otherTopic.conversation, { closed: true })).status).toBe(404)
  const conversation = await patch(secret, channel, { title: 'Renamed channel' })
  expect(await reasonOf(conversation)).toBe('topic_conversation')
  const pinned = await patch(secret, thread.id, { keepOpen: true })
  expect(pinned.status).toBe(403)
  expect(await reasonOf(pinned)).toBe('key_keep_open')

  // The forward read shows the key's message to a Persona as the owner's, with whom it went to.
  const persona = Schema.decodeUnknownSync(Made)(
    await (
      await asKey(url, secret, 'POST', '/api/personas', {
        name: 'Scout',
        avatar: { glyph: 'S', hue: 120 },
        role: 'Finds things out',
        instructions: 'Be brief.',
        operationId: 'svc:persona:1',
      })
    ).json(),
  )
  const tagged = await asKey(url, secret, 'POST', `/api/conversations/${thread.id}/messages`, {
    input: 'find the venue',
    operationId: 'svc:msg:tagged',
    selections: [{ kind: 'persona', personaId: persona.id }],
  })
  expect(tagged.status, await tagged.clone().text()).toBe(202)
  const read = Schema.decodeUnknownSync(ConversationEntries)(
    await (await asKey(url, secret, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).json(),
  )
  expect(read.entries).toContainEqual(
    expect.objectContaining({
      kind: 'message',
      role: 'owner',
      text: 'find the venue',
      to: [{ id: persona.id, name: 'Scout' }],
    }),
  )
}
