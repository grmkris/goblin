// A chat's AG-UI stream on the real Worker, agent and stream objects (docs/architecture/streams.md): joined, read from
// the start and resumed from an offset, in the tier the caller may read, moved to a new epoch at a run's end (the
// owner stack moves every stream there), refused with a token goblin did not sign or that expired, and appended once
// when an acknowledgement is lost.
import { EventSchema } from '@ag-ui/core/schemas'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type AguiEvent, ConversationStream, EventType, TopicView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { streamReadToken } from '../../src/streams/read-token.ts'
import { callOwner } from '../owner-client.ts'
import { type Person, call, lever, ownerFetch, person, signedIn } from './owner-requests.ts'

/** The owner stack's credential key (`owner-stack.ts`), which signs its stream URLs. */
const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
/** How long a case waits for a run to show in a stream. */
const WAIT_MS = 30_000

const Secret = Schema.Struct({ secret: Schema.String })

/** A stream URL as the test reaches it: the Worker at `base` stands where the deployment's origin does. */
const local = (base: string, url: string) => `${base}${new URL(url).pathname}`

/** Every event of a read, each valid AG-UI 1.0 by `@ag-ui/core`'s own schemas. */
function valid(value: unknown): AguiEvent[] {
  expect(Array.isArray(value), JSON.stringify(value)).toBe(true)
  const events = Array.isArray(value) ? value : []
  for (const event of events) {
    const parsed = EventSchema.safeParse(event)
    expect(parsed.success, `${JSON.stringify(event).slice(0, 200)} ${parsed.error?.message ?? ''}`).toBe(true)
  }
  // SAFETY: every element was just checked against AG-UI's event schema.
  return events as AguiEvent[]
}

type Read = { readonly events: AguiEvent[]; readonly offset: string; readonly closed: boolean }

/** One read of `url` from `offset` (`-1`: the epoch's start), waiting for more with long-poll. */
async function readOnce(base: string, url: string, offset: string): Promise<Read> {
  const response = await ownerFetch(`${local(base, url)}?offset=${offset}&live=long-poll`)
  const next = response.headers.get('stream-next-offset') ?? offset
  const closed = response.headers.get('stream-closed') === 'true'
  expect(response.headers.get('cache-control')).toBe('no-store')
  if (response.status === 204) return { events: [], offset: next, closed }
  expect(response.status, await response.clone().text()).toBe(200)
  return { events: valid(await response.json()), offset: next, closed }
}

/** Reads `url` from `offset` until `done` holds for what was read (or the stream closed); everything read, in order. */
async function readUntil(
  base: string,
  url: string,
  offset: string,
  done: (events: readonly AguiEvent[]) => boolean,
): Promise<Read> {
  const events: AguiEvent[] = []
  const deadline = Date.now() + WAIT_MS
  let at = offset
  for (;;) {
    const read = await readOnce(base, url, at)
    events.push(...read.events)
    at = read.offset
    if (done(events) || read.closed) return { events, offset: at, closed: read.closed }
    if (Date.now() > deadline) throw new Error(`no end in ${JSON.stringify(events.map(({ type }) => type))}`)
  }
}

const ofType = <T extends EventType>(events: readonly AguiEvent[], type: T) =>
  events.filter((event): event is Extract<AguiEvent, { type: T }> => event.type === type)

/** The text an assistant's content deltas add up to, message by message. */
const answers = (events: readonly AguiEvent[]): string[] => {
  const ids = ofType(events, EventType.TEXT_MESSAGE_START).flatMap((event) =>
    event.role === 'assistant' ? [event.messageId] : [],
  )
  return ids.map((id) =>
    ofType(events, EventType.TEXT_MESSAGE_CONTENT)
      .filter((event) => event.messageId === id)
      .map(({ delta }) => delta)
      .join(''),
  )
}

const ended = (events: readonly AguiEvent[]) =>
  events.some(({ type }) => type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR)
const moved = (events: readonly AguiEvent[]) =>
  ofType(events, EventType.CUSTOM).some(({ name }) => name === 'goblin.stream.moved')

/** `who`'s join of `chat`'s stream through the typed client. */
const join = (base: string, who: Person, chat: string) =>
  callOwner(signedIn(base, who), (api) => api.conversations.stream({ params: { id: chat } }))

/** A message into `chat` from `who`'s browser. */
const send = (base: string, who: Person, chat: string, input: string) =>
  callOwner(signedIn(base, who), (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId: `stream:${input}` } }),
  )

/** The owner's own chat in the full tier: everything from the start, then only what came after an offset. */
async function ownerReads(url: string, owner: Person) {
  const joined = await join(url, owner, '1')
  expect(joined).toMatchObject({ epoch: 1, tier: 'full' })
  expect(Date.parse(joined.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000)
  const opening = await readOnce(url, joined.url, '-1')
  expect(opening.events.map(({ type }) => type).slice(0, 2)).toEqual([
    EventType.MESSAGES_SNAPSHOT,
    EventType.STATE_SNAPSHOT,
  ])
  await send(url, owner, '1', 'hello stream')
  const run = await readUntil(url, joined.url, opening.offset, ended)
  // Resumed from the offset the opening answered: only what came later, the run from its start.
  expect(ofType(run.events, EventType.MESSAGES_SNAPSHOT)).toEqual([])
  const types = run.events.map(({ type }) => type)
  expect(types.indexOf(EventType.RUN_STARTED)).toBeLessThan(types.indexOf(EventType.TEXT_MESSAGE_START))
  expect(answers(run.events)).toEqual(['echo: hello stream'])
  const [started] = ofType(run.events, EventType.RUN_STARTED)
  expect(started?.metadata).toEqual({ goblin: { operations: ['stream:hello stream'] } })
  return { joined, run }
}

/**
 * The run's end moves the stream (the owner stack's threshold): the old epoch ends moved and closed, the new opens.
 * `run` is what the run's read already had, which may hold the move too.
 */
async function rotation(url: string, owner: Person, joined: ConversationStream, run: Read) {
  const rest = await readUntil(url, joined.url, run.offset, (events) => moved([...run.events, ...events]))
  expect(rest.closed || (await readOnce(url, joined.url, rest.offset)).closed).toBe(true)
  const [move] = ofType([...run.events, ...rest.events], EventType.CUSTOM)
  expect(move).toMatchObject({ name: 'goblin.stream.moved', value: { epoch: 2 } })
  const next = await join(url, owner, '1')
  expect(next.epoch).toBe(2)
  const opening = await readOnce(url, next.url, '-1')
  const [snapshot] = ofType(opening.events, EventType.MESSAGES_SNAPSHOT)
  const said = JSON.stringify(snapshot?.messages ?? [])
  expect(said).toContain('hello stream')
  expect(said).toContain('echo: hello stream')
  return { next, offset: opening.offset }
}

/** An expired URL, or one whose token was altered, reaches nothing. */
async function refusedTokens(url: string, owner: Person, joined: ConversationStream) {
  const claims = { workspaceId: owner.workspace, chat: '1', tier: 'full', epoch: joined.epoch } as const
  const expired = await streamReadToken(KEY, { ...claims, expiresAt: Math.floor(Date.now() / 1000) - 1 })
  const token = new URL(joined.url).pathname.slice('/streams/'.length)
  const altered = `${token.slice(0, 5)}${token[5] === 'A' ? 'B' : 'A'}${token.slice(6)}`
  for (const each of [expired, altered]) {
    const refused = await ownerFetch(`${url}/streams/${each}?offset=-1`)
    expect(refused.status).toBe(401)
  }
}

/** One acknowledgement lost: the agent sends the same bytes again and the stream keeps them once. */
async function lostAcknowledgement(url: string, owner: Person, joined: ConversationStream, offset: string) {
  expect((await lever(url, owner, 'streams/lose', { appends: 1 })).status).toBe(200)
  await send(url, owner, '1', 'once only')
  const run = await readUntil(url, joined.url, offset, ended)
  expect(answers(run.events)).toEqual(['echo: once only'])
  expect(ofType(run.events, EventType.RUN_STARTED)).toHaveLength(1)
  const starts = ofType(run.events, EventType.TEXT_MESSAGE_START).map(({ messageId }) => messageId)
  expect(new Set(starts).size).toBe(starts.length)
  const losing = Schema.decodeUnknownSync(Schema.Struct({ losing: Schema.Int }))(
    await (await lever(url, owner, 'streams/losing')).json(),
  )
  expect(losing.losing).toBe(0)
}

/** A key reads its own Topic's chat in the answers tier, and no other chat. */
async function keyReads(url: string, owner: Person) {
  const made = await call(url, owner, '/api/keys', {
    name: 'streams',
    scopes: ['topics', 'conversations'],
    servers: [],
    expiresInDays: 1,
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const { secret } = Schema.decodeUnknownSync(Secret)(await made.json())
  const asKey = (method: string, path: string, body?: unknown) =>
    ownerFetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const topic = Schema.decodeUnknownSync(TopicView)(
    await (await asKey('POST', '/api/topics', { name: 'Streamed room', operationId: 'streams:topic' })).json(),
  )
  const chat = topic.conversation
  const joined = Schema.decodeUnknownSync(ConversationStream)(
    await (await asKey('GET', `/api/conversations/${chat}/stream`)).json(),
  )
  expect(joined.tier).toBe('answers')
  const opening = await readOnce(url, joined.url, '-1')
  const sent = await asKey('POST', `/api/conversations/${chat}/messages`, {
    input: 'hello from a key',
    operationId: 'streams:key:1',
  })
  expect(sent.status, await sent.clone().text()).toBe(202)
  const run = await readUntil(url, joined.url, opening.offset, ended)
  const all = [...opening.events, ...run.events]
  expect(answers(all)).toEqual(['echo: hello from a key'])
  expect(all.filter(({ type }) => /^(?:REASONING_|TOOL_CALL_|STEP_)/u.test(type))).toEqual([])
  for (const { delta } of ofType(all, EventType.STATE_DELTA))
    expect(delta.every(({ path }) => path.startsWith('/attention'))).toBe(true)
  // The owner's own chat is out of the key's reach.
  expect((await asKey('GET', '/api/conversations/1/stream')).status).toBe(404)
  await keyOverMcp(url, secret, chat)
}

/** The same join as a key's MCP tool, `conversation_stream`: the answers tier of its own chat, and no other. */
async function keyOverMcp(url: string, secret: string, chat: string) {
  const client = new Client({ name: 'streams-fixture', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      fetch: (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('authorization', `Bearer ${secret}`)
        return fetch(input, { ...init, headers: sent })
      },
    }),
  )
  try {
    const followed = await client.callTool({ name: 'conversation_stream', arguments: { chat } })
    expect(followed.isError, JSON.stringify(followed)).toBeFalsy()
    expect(followed.structuredContent).toMatchObject({ tier: 'answers' })
    const other = await client.callTool({ name: 'conversation_stream', arguments: { chat: '1' } })
    expect(other.isError).toBe(true)
  } finally {
    await client.close()
  }
}

/** The streams case (docs/architecture/streams.md). */
export async function streamsCase(url: string): Promise<void> {
  const owner = await person(url)
  const { joined, run } = await ownerReads(url, owner)
  const { next, offset } = await rotation(url, owner, joined, run)
  await refusedTokens(url, owner, next)
  await lostAcknowledgement(url, owner, next, offset)
  await keyReads(url, owner)
}
