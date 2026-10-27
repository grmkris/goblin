import { ConversationEntries, StartedThread, TopicView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import {
  type Person,
  type Server,
  appToken,
  asServer,
  call,
  person,
  scriptApp,
  signedIn,
  tokenRequest,
} from './owner-requests.ts'
import { ownerSnapshot } from './probe-reads.ts'

const Snapshot = Schema.Struct({
  entries: Schema.optional(Schema.Array(Schema.Struct({ kind: Schema.String, data: Schema.optional(Schema.Unknown) }))),
})
const Made = Schema.Struct({ id: Schema.Int })
const Refusal = Schema.Struct({ error: Schema.Struct({ reason: Schema.optional(Schema.String) }) })
const Rotated = Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String })

/**
 * A new secret for `who`'s app `server` (ADR 0118), as an admin rotates it in Settings: the same app, its new secret.
 */
async function rotated(base: string, who: Person, server: Server): Promise<string> {
  const answer = await call(base, who, `/api/developer/apps/${server.clientId}/rotate`, {})
  expect(answer.status, await answer.clone().text()).toBe(200)
  const { clientId, clientSecret } = Schema.decodeUnknownSync(Rotated)(await answer.json())
  expect(clientId).toBe(server.clientId)
  return clientSecret
}

const reasonOf = async (response: Response) => Schema.decodeUnknownSync(Refusal)(await response.json()).error.reason

/**
 * ADR 0090 on the real Worker and agent: an installed app titles the empty threads it starts, which announce themselves
 * in their Topic's Conversation once; it renames, closes and reopens its own threads and no other chat; and the forward
 * read shows its message to a Persona as the owner's, with whom it went to. Its secret rotated (ADR 0118), the old one
 * gets no token and the new one's token keeps all of that.
 */
export async function appThreadsCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  const made = await scriptApp(url, owner, 'threads', { level: 'manage', lists: true })
  const other = await scriptApp(url, owner, 'other threads', { level: 'write', lists: true })
  const topicOf = async (server: Server, name: string, operationId: string) =>
    Schema.decodeUnknownSync(TopicView)(
      await (await asServer(url, server, 'POST', '/api/topics', { name, operationId })).json(),
    )
  const topic = await topicOf(made, 'Customer 1', 'svc:topic:1')
  const otherTopic = await topicOf(other, 'Customer 2', 'svc:topic:2')
  const channel = topic.conversation
  const notes = async () =>
    (Schema.decodeUnknownSync(Snapshot)(await ownerSnapshot(me, channel)).entries ?? []).filter(
      (entry) => entry.kind === 'app.thread_started',
    )

  // A titled empty thread is named at once and announced in its Topic's Conversation once, also when replayed.
  // Literal AG-UI bodies, as a server's own code sends them (ADR 0111).
  const message = (runId: string, content: string) => ({
    threadId: channel,
    runId,
    messages: [{ id: `${runId}:user`, role: 'user', content }],
  })
  const start = { anchor: 'empty', title: 'Job 1', message: message('svc:job:1', 'start the job') }
  const started = await asServer(url, made, 'POST', `/api/conversations/${channel}/threads`, start)
  expect(started.status, await started.clone().text()).toBe(201)
  const { thread } = Schema.decodeUnknownSync(StartedThread)(await started.json())
  expect(thread).toMatchObject({ kind: 'thread', parent: channel, title: 'Job 1' })
  expect(await notes()).toEqual([{ kind: 'app.thread_started', data: { thread: thread.id } }])
  const replay = await asServer(url, made, 'POST', `/api/conversations/${channel}/threads`, start)
  expect(Schema.decodeUnknownSync(StartedThread)(await replay.json()).thread.id).toBe(thread.id)
  expect(await notes()).toHaveLength(1)

  // An untitled empty thread owes its note until it is named; a rename (here the owner's) writes it, once.
  const untitled = { anchor: 'empty', message: message('svc:agent:1', 'start the job') }
  const plain = Schema.decodeUnknownSync(StartedThread)(
    await (await asServer(url, made, 'POST', `/api/conversations/${channel}/threads`, untitled)).json(),
  ).thread
  const rename = (title: string) =>
    callOwner(me, (api) => api.conversations.update({ params: { id: plain.id }, payload: { title } }))
  await rename('Agent thread')
  await rename('Agent thread, renamed')
  expect((await notes()).filter((note) => JSON.stringify(note.data).includes(plain.id))).toHaveLength(1)

  // The app renames, closes and reopens its own thread; closing refuses a send and keeps the chat readable.
  const patch = (server: Server, chat: string, change: unknown) =>
    asServer(url, server, 'PATCH', `/api/conversations/${chat}`, change)
  expect(await (await patch(made, thread.id, { title: 'Job 1, done' })).json()).toMatchObject({
    title: 'Job 1, done',
  })
  expect((await patch(made, thread.id, { closed: true })).status).toBe(200)
  const closedSend = await asServer(url, made, 'POST', `/api/conversations/${thread.id}/messages`, {
    threadId: thread.id,
    runId: 'svc:msg:closed',
    messages: [{ id: 'closed', role: 'user', content: 'one more thing' }],
  })
  expect(await reasonOf(closedSend)).toBe('conversation_closed')
  expect((await asServer(url, made, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).status).toBe(200)
  expect((await patch(made, thread.id, { closed: false })).status).toBe(200)

  // Nothing else: another app's chat (outside its grant's reach), its Topic's Conversation, or pinning a chat open.
  expect((await patch(other, thread.id, { title: 'Mine now' })).status).toBe(403)
  expect((await patch(made, otherTopic.conversation, { closed: true })).status).toBe(403)
  const conversation = await patch(made, channel, { title: 'Renamed channel' })
  expect(await reasonOf(conversation)).toBe('topic_conversation')
  const pinned = await patch(made, thread.id, { keepOpen: true })
  expect(pinned.status).toBe(403)
  expect(await reasonOf(pinned)).toBe('credential_keep_open')

  // The forward read shows the app's message to a Persona as the owner's, with whom it went to.
  const persona = Schema.decodeUnknownSync(Made)(
    await (
      await asServer(url, made, 'POST', '/api/personas', {
        name: 'Scout',
        avatar: { glyph: 'S', hue: 120 },
        role: 'Finds things out',
        instructions: 'Be brief.',
        operationId: 'svc:persona:1',
      })
    ).json(),
  )
  const tagged = await asServer(url, made, 'POST', `/api/conversations/${thread.id}/messages`, {
    threadId: thread.id,
    runId: 'svc:msg:tagged',
    messages: [{ id: 'tagged', role: 'user', content: 'find the venue' }],
    forwardedProps: { goblin: { selections: [{ kind: 'persona', personaId: persona.id }] } },
  })
  expect(tagged.status, await tagged.clone().text()).toBe(202)
  const read = Schema.decodeUnknownSync(ConversationEntries)(
    await (await asServer(url, made, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).json(),
  )
  expect(read.entries).toContainEqual(
    expect.objectContaining({
      kind: 'message',
      role: 'owner',
      text: 'find the venue',
      to: [{ id: persona.id, name: 'Scout' }],
    }),
  )

  // A rotated secret (ADR 0118) is the same app: the old secret gets no token at once, and the new one's token reads
  // back the thread the app started and still reaches nothing else.
  const renewed = await rotated(url, owner, made)
  expect((await tokenRequest(url, made.clientId, made.secret)).status).toBe(401)
  const fresh = { ...made, secret: renewed, token: await appToken(url, made.clientId, renewed) }
  const reread = Schema.decodeUnknownSync(ConversationEntries)(
    await (await asServer(url, fresh, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).json(),
  )
  expect(reread.entries).toContainEqual(expect.objectContaining({ kind: 'message', text: 'find the venue' }))
  expect((await patch(fresh, otherTopic.conversation, { closed: true })).status).toBe(403)
}
