import { ConversationEntries, StartedThread, TopicView, runInput, threadStart } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, call, lever, ownerFetch, person, signedIn, workspaceOf } from './owner-requests.ts'
import { roomAllows } from '../../src/pi/room.ts'
import { until } from './until.ts'

const Secret = Schema.Struct({ secret: Schema.String })
const Made = Schema.Struct({ id: Schema.Int })
const Refusal = Schema.Struct({ error: Schema.Struct({ reason: Schema.optional(Schema.String) }) })
const Calls = Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Unknown }))
const Seen = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
      tools: Schema.Array(Schema.String),
      context: Schema.optional(Schema.String),
    }),
  ),
})

/** The fixture's origin and its one tool, as the owner grants them to the key (ADR 0091). */
const ORIGIN = 'https://apps-fixture.test'
const SERVER = { name: 'swarmm', url: `${ORIGIN}/mcp`, tools: ['board'] }

/** A key of `who` with `origins` granted, as the owner makes it in Settings: its secret. */
async function keyOf(base: string, who: Person): Promise<{ readonly secret: string; readonly id: string }> {
  const made = await call(base, who, '/api/keys', {
    name: 'jobs',
    scopes: ['topics', 'conversations', 'personas'],
    servers: [],
    origins: [{ origin: ORIGIN, tools: ['board'] }],
    expiresInDays: 1,
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const created = Schema.decodeUnknownSync(
    Schema.Struct({ ...Secret.fields, key: Schema.Struct({ id: Schema.String }) }),
  )(await made.json())
  return { secret: created.secret, id: created.key.id }
}

const asKey = (base: string, secret: string, method: string, path: string, body?: unknown) =>
  ownerFetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const reasonOf = async (response: Response) => Schema.decodeUnknownSync(Refusal)(await response.json()).error.reason

/**
 * ADR 0103 on the real Worker and agent: a key declares an MCP server on the job thread it starts; the Persona it tags
 * there (native tools, ADR 0102) calls the server's tool by its declared name; a replay with a new token is the same
 * thread; the owner's session cannot declare one; and closing the thread drops it.
 */
export async function threadServersCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  // The owner's own request gives the agent resident authority, which a key's thread still needs.
  await callOwner(me, (api) => api.personas.list({ query: {} }))
  const { secret, id: keyId } = await keyOf(url, owner)
  const topic = Schema.decodeUnknownSync(TopicView)(
    await (await asKey(url, secret, 'POST', '/api/topics', { name: 'Customer 7', operationId: 'svc:topic:7' })).json(),
  )
  const persona = Schema.decodeUnknownSync(Made)(
    await (
      await asKey(url, secret, 'POST', '/api/personas', {
        name: 'Maker',
        avatar: { glyph: 'M', hue: 30 },
        role: 'Makes the job',
        instructions: 'Deliver.',
        tools: 'native',
        operationId: 'svc:persona:maker',
      })
    ).json(),
  )
  const start = (token: string, chat = topic.conversation, operationId = 'svc:job:7', title = 'Job 7') =>
    threadStart(chat, {
      operationId,
      anchor: 'empty',
      title,
      message: {
        input: `persona-call swarmm__board ${JSON.stringify({ operationKey: 'thread-server' })}`,
        selections: [{ kind: 'persona', personaId: persona.id }],
      },
      mcpServers: [{ ...SERVER, token }],
    })
  const threads = `/api/conversations/${topic.conversation}/threads`
  const started = await asKey(url, secret, 'POST', threads, start('job-token-1'))
  expect(started.status, await started.clone().text()).toBe(201)
  const { thread } = Schema.decodeUnknownSync(StartedThread)(await started.json())
  // The answer echoes the server without its token.
  expect(thread.mcpServers).toEqual([SERVER])
  expect(JSON.stringify(thread)).not.toContain('job-token-1')

  // The tagged Persona's fork calls the declared server's tool natively, by its declared name.
  const calls = async () => Schema.decodeUnknownSync(Calls)(await (await lever(url, owner, 'approvals/calls')).json())
  const ran = await until(
    calls,
    (found) => found.some((each) => JSON.stringify(each.args).includes('thread-server')),
    20_000,
  )
  expect(ran).toContainEqual({ name: 'board', args: { operationKey: 'thread-server' } })
  const read = Schema.decodeUnknownSync(ConversationEntries)(
    await (await asKey(url, secret, 'GET', `/api/conversations/${thread.id}/entries?after=0`)).json(),
  )
  expect(JSON.stringify(read)).not.toContain('job-token-1')

  // A retry of the same operation with a fresh token is the same thread, not a conflict.
  const replay = await asKey(url, secret, 'POST', threads, start('job-token-2'))
  expect(replay.status, await replay.clone().text()).toBe(201)
  expect(Schema.decodeUnknownSync(StartedThread)(await replay.json()).thread.id).toBe(thread.id)
  // The same operation naming another server is.
  const other = { ...start('job-token-3'), mcpServers: [{ ...SERVER, url: `${ORIGIN}/other`, token: 'x' }] }
  expect(await reasonOf(await asKey(url, secret, 'POST', threads, other))).toBe('thread_servers')

  // The owner's own session declares none, and an origin the key was not granted is refused.
  const mine = await call(url, owner, '/api/conversations/1/threads', start('t', '1', 'own:job:1'))
  expect(mine.status).toBe(403)
  expect(await reasonOf(mine)).toBe('key_only')
  const elsewhere = {
    ...start('t', topic.conversation, 'svc:job:8', 'Job 8'),
    mcpServers: [{ ...SERVER, url: 'https://evil.test/mcp', token: 't' }],
  }
  expect(await reasonOf(await asKey(url, secret, 'POST', threads, elsewhere))).toBe('key_origin')
  // Refused before anything was made: there is no thread of that operation.
  expect((await workspaceOf(url, owner)).conversations.some((view) => view.title === 'Job 8')).toBe(false)
  // Servers are a Thread's alone: not its Topic's Conversation's.
  const onChannel = await asKey(url, secret, 'PATCH', `/api/conversations/${topic.conversation}`, {
    mcpServers: { operationId: 'svc:servers:channel', set: [{ ...SERVER, token: 't' }] },
  })
  expect(await reasonOf(onChannel)).toBe('not_a_thread')

  // A Persona on the gateway (ADR 0102) in the same thread is offered no thread server's tools.
  const plain = Schema.decodeUnknownSync(Made)(
    await (
      await asKey(url, secret, 'POST', '/api/personas', {
        name: 'Plain',
        avatar: { glyph: 'P', hue: 60 },
        role: 'Answers plainly',
        instructions: 'Answer.',
        operationId: 'svc:persona:plain',
      })
    ).json(),
  )
  await asKey(
    url,
    secret,
    'POST',
    `/api/conversations/${thread.id}/messages`,
    runInput(thread.id, {
      input: 'plain question',
      operationId: 'svc:msg:plain',
      selections: [{ kind: 'persona', personaId: plain.id }],
    }),
  )
  const seen = async () => Schema.decodeUnknownSync(Seen)(await (await lever(url, owner, 'queue/seen')).json()).requests
  const plainRequest = (
    await until(
      seen,
      (requests) => requests.some((request) => request.context?.includes('You are Plain') === true),
      20_000,
    )
  ).find((request) => request.context?.includes('You are Plain') === true)
  expect(plainRequest?.tools).toContain('mcp_call')
  expect(plainRequest?.tools).not.toContain('swarmm__board')

  // The key's Topic is a room (ADR 0108): its Persona's fork keeps what a server's job needs, its native tools, skills
  // and questions, its native call ran above, and it is offered nothing a room leaves out.
  const maker = (await seen()).find((request) => request.context?.includes('You are Maker') === true)
  expect(maker?.tools).toEqual(expect.arrayContaining(['swarmm__board', 'skill_activate', 'ask_user']))
  expect(maker?.tools.filter((tool) => !roomAllows(tool))).toEqual([])
  expect(maker?.context).toContain('You reach only this room')

  // Closing the thread drops its servers; reopening brings none back.
  const patch = (change: unknown) => asKey(url, secret, 'PATCH', `/api/conversations/${thread.id}`, change)
  expect((await patch({ closed: true })).status).toBe(200)
  const reopened = await (await patch({ closed: false })).json()
  expect(reopened).not.toHaveProperty('mcpServers')
  // A key's change sets them again, as a whole.
  const set = await patch({ mcpServers: { operationId: 'svc:servers:7', set: [{ ...SERVER, token: 'job-token-4' }] } })
  expect(set.status, await set.clone().text()).toBe(200)
  expect(await set.json()).toMatchObject({ mcpServers: [SERVER] })
  // The owner may clear them, though never declare one.
  const cleared = await callOwner(me, (api) =>
    api.conversations.update({
      params: { id: thread.id },
      payload: { mcpServers: { operationId: 'own:clear', set: [] } },
    }),
  )
  expect(cleared).not.toHaveProperty('mcpServers')

  // Once the owner revokes the key, its thread's servers reach nothing: the next answer is offered none of them.
  await patch({ mcpServers: { operationId: 'svc:servers:8', set: [{ ...SERVER, token: 'job-token-5' }] } })
  const revoked = await me.fetch(new Request(`${url}/api/keys/${keyId}`, { method: 'DELETE' }))
  expect(revoked.status, await revoked.clone().text()).toBeLessThan(300)
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: thread.id },
      payload: runInput(thread.id, {
        input: `persona-call swarmm__board ${JSON.stringify({ operationKey: 'after-revoke' })}`,
        operationId: 'own:msg:revoked',
        selections: [{ kind: 'persona', personaId: persona.id }],
      }),
    }),
  )
  const asked = (requests: Awaited<ReturnType<typeof seen>>) =>
    requests.filter(
      (request) =>
        request.context?.includes('You are Maker') === true &&
        request.messages.some((message) => message.text.includes('after-revoke')),
    )
  const afterRevoke = asked(await until(seen, (requests) => asked(requests).length > 0, 20_000))
  expect(afterRevoke[0]?.tools).not.toContain('swarmm__board')
  expect(JSON.stringify(await calls())).not.toContain('after-revoke')

  // No token reaches what inspection reads, content-free as it is.
  for (const path of ['/api/inspect/turns', '/api/inspect/flows']) {
    const text = await (await call(url, owner, path)).text()
    expect(text, path).not.toContain('job-token')
  }
}
