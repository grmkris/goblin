// A chat's AG-UI stream on the real Worker and agent (docs/architecture/streams.md, ADR 0110): a member reads it
// through their workspace with their session, as server-sent events that open with the chat's snapshots and then carry
// everything live (text, reasoning, tool calls and their results); a reconnect opens with a fresh snapshot that holds
// what came meanwhile; a server's key reads its own Topic's chat in full and no other chat; and a chat past the readers
// it takes refuses one more as `stream_busy`.
import { EventSchema } from '@ag-ui/core/schemas'
import { type AguiEvent, ConversationEntries, EventType, TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, call, keyBody, ownerFetch, person, signedIn } from './owner-requests.ts'
import { waitFor } from './until.ts'

/** How long a case waits for something to show in a stream. */
const WAIT_MS = 30_000

export const Secret = Schema.Struct({ secret: Schema.String })

/** One event of a `data:` frame, valid AG-UI 1.0 by `@ag-ui/core`'s own schemas. */
function valid(json: string): AguiEvent {
  const event: unknown = JSON.parse(json)
  const parsed = EventSchema.safeParse(event)
  expect(parsed.success, `${json.slice(0, 200)} ${parsed.error?.message ?? ''}`).toBe(true)
  // SAFETY: the event was just checked against AG-UI's event schema.
  return event as AguiEvent
}

/** A connection to a chat's stream as a reader holds it: the events read so far, in order, and reading on. */
export class StreamRead {
  readonly events: AguiEvent[] = []
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #decoder = new TextDecoder()
  #buffer = ''
  #ended = false

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader()
  }

  /** Whether the server ended the connection. */
  get ended(): boolean {
    return this.#ended
  }

  /** Reads on until `done` holds for everything read so far, and answers what was read. */
  async until(done: (events: readonly AguiEvent[]) => boolean): Promise<AguiEvent[]> {
    const deadline = Date.now() + WAIT_MS
    while (!done(this.events)) {
      if (this.#ended) throw new Error(`the stream ended at ${this.#types()}`)
      const left = deadline - Date.now()
      const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), Math.max(0, left)))
      const read = await Promise.race([this.#reader.read(), late])
      if (read === 'late') throw new Error(`no end in ${this.#types()}`)
      if (read.done) this.#ended = true
      else this.#take(this.#decoder.decode(read.value, { stream: true }))
    }
    return this.events
  }

  /** The reader goes away. */
  async close(): Promise<void> {
    // expected: a connection the server ended already has nothing to cancel
    await this.#reader.cancel().catch(() => undefined)
  }

  #types(): string {
    return JSON.stringify(this.events.map(({ type }) => type))
  }

  /** Frames as they come: each `data:` line one event, comment lines ignored; LF line ends only. */
  #take(text: string): void {
    this.#buffer += text
    expect(this.#buffer).not.toContain('\r')
    const frames = this.#buffer.split('\n\n')
    this.#buffer = frames.pop() ?? ''
    for (const frame of frames)
      for (const line of frame.split('\n')) if (line.startsWith('data: ')) this.events.push(valid(line.slice(6)))
  }
}

/** `response` as a stream connection, after checking it is one: server-sent events, never cached. */
export function streamOf(response: Response): StreamRead {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(response.headers.get('cache-control')).toBe('no-store')
  if (response.body === null) throw new Error('a stream without a body')
  return new StreamRead(response.body)
}

/** `who`'s browser connects to `chat`'s stream, under their workspace with their session (ADR 0089). */
export const memberStream = async (base: string, who: Person, chat: string) =>
  streamOf(await call(base, who, `/api/conversations/${chat}/stream`))

/** A server's key on the owner API at `base`: a request with it as the bearer, as a server sends one. */
export const keyFetch =
  (base: string, secret: string) =>
  (method: string, path: string, body?: unknown): Promise<Response> =>
    ownerFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

/** A new key of `owner` whose grant manages only what it makes (ADR 0114: its Topics and Personas a list), as its secret. */
export async function newKey(base: string, owner: Person, name: string): Promise<string> {
  const made = await call(base, owner, '/api/keys', keyBody(owner, name, { lists: true }))
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Secret)(await made.json()).secret
}

export const ofType = <T extends EventType>(events: readonly AguiEvent[], type: T) =>
  events.filter((event): event is Extract<AguiEvent, { type: T }> => event.type === type)

/** The text an assistant's content deltas add up to, message by message, a child's left out. */
const answers = (events: readonly AguiEvent[]): string[] => {
  const ids = ofType(events, EventType.TEXT_MESSAGE_START).flatMap((event) =>
    event.role === 'assistant' && event.subagentRunId === undefined ? [event.messageId] : [],
  )
  return ids.map((id) =>
    ofType(events, EventType.TEXT_MESSAGE_CONTENT)
      .filter((event) => event.messageId === id)
      .map(({ delta }) => delta)
      .join(''),
  )
}

export const ended = (events: readonly AguiEvent[]) =>
  events.some(({ type }) => type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR)

/** The opening a connection begins with: the chat's messages, then its whole STATE document. */
function opened(events: readonly AguiEvent[]) {
  expect(events.slice(0, 2).map(({ type }) => type)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.STATE_SNAPSHOT])
  const [, state] = events
  expect(state?.type === EventType.STATE_SNAPSHOT ? Object.keys(state.snapshot ?? {}).toSorted() : []).toEqual([
    'agent',
    'attention',
    'compactions',
    'generation',
    'queue',
    'usage',
  ])
  const [messages] = ofType(events, EventType.MESSAGES_SNAPSHOT)
  return JSON.stringify(messages?.messages ?? [])
}

/** A message into `chat` from `who`'s browser, as operation `stream:<input>`. */
const send = (base: string, who: Person, chat: string, input: string) =>
  callOwner(signedIn(base, who), (api) =>
    api.conversations.submit({
      params: { id: chat },
      payload: runInput(chat, { input, operationId: `stream:${input}` }),
    }),
  )

/**
 * The owner follows their own chat: the opening, then the turn they send live in full: its run with the operation it
 * answers, the model's thinking, its tool call with the result, and its answer.
 */
async function memberReads(url: string, owner: Person): Promise<StreamRead> {
  const stream = await memberStream(url, owner, '1')
  await stream.until((events) => events.length >= 2)
  opened(stream.events)
  const input = 'think call subagent_status {}'
  await send(url, owner, '1', input)
  const run = (await stream.until(ended)).slice(2)
  const types = run.map(({ type }) => type)
  expect(types.indexOf(EventType.RUN_STARTED)).toBeLessThan(types.indexOf(EventType.REASONING_START))
  const [started] = ofType(run, EventType.RUN_STARTED)
  expect(started?.metadata).toEqual({ goblin: { operations: [`stream:${input}`] } })
  expect(ofType(run, EventType.REASONING_MESSAGE_CONTENT).map(({ delta }) => delta)).toContain(
    'Thinking about call subagent_status {}.',
  )
  expect(ofType(run, EventType.TOOL_CALL_START)).toEqual([expect.objectContaining({ toolCallName: 'subagent_status' })])
  expect(ofType(run, EventType.TOOL_CALL_RESULT)).toHaveLength(1)
  expect(answers(run).at(-1)).toMatch(/^done: /u)
  expect(ofType(run, EventType.RUN_FINISHED).at(-1)).toMatchObject({ outcome: { type: 'success' } })
  return stream
}

/**
 * The reader goes away, the chat goes on without it, and its reconnect opens with a fresh snapshot that holds what came
 * meanwhile: nothing is lost, and nothing of the opening is a run any more.
 */
async function reconnect(url: string, owner: Person, gone: StreamRead) {
  await gone.close()
  await send(url, owner, '1', 'while away')
  const me = signedIn(url, owner)
  await waitFor(
    () => callOwner(me, (api) => api.conversations.entries({ params: { id: '1' }, query: { after: 0 } })),
    (read: ConversationEntries) =>
      read.activity === 'idle' && JSON.stringify(read.entries).includes('echo: while away'),
    'the turn sent while away',
    WAIT_MS,
  )
  const again = await memberStream(url, owner, '1')
  const opening = await again.until((events) => events.length >= 2)
  const said = opened(opening)
  for (const words of ['think call subagent_status {}', 'done: ', 'while away', 'echo: while away'])
    expect(said).toContain(words)
  expect(said).toContain('"role":"reasoning"')
  await again.close()
}

/**
 * A server's key reads its own Topic's chat in full: the opening with the whole STATE, then its thinking and its
 * answer; another key's Topic and the owner's own chat are out of its grant's reach (ADR 0114: `access_insufficient`).
 */
async function keyReads(url: string, owner: Person) {
  const asKey = keyFetch(url, await newKey(url, owner, 'streams'))
  const topic = Schema.decodeUnknownSync(TopicView)(
    await (await asKey('POST', '/api/topics', { name: 'Streamed customer', operationId: 'streams:topic' })).json(),
  )
  const chat = topic.conversation
  const stream = streamOf(await asKey('GET', `/api/conversations/${chat}/stream`))
  await stream.until((events) => events.length >= 2)
  opened(stream.events)
  const sent = await asKey(
    'POST',
    `/api/conversations/${chat}/messages`,
    runInput(chat, { input: 'think hello from a key', operationId: 'streams:key:1' }),
  )
  expect(sent.status, await sent.clone().text()).toBe(202)
  const run = await stream.until(ended)
  expect(answers(run)).toEqual(['echo: hello from a key'])
  expect(ofType(run, EventType.REASONING_MESSAGE_CONTENT).map(({ delta }) => delta)).toEqual([
    'Thinking about hello from a key.',
  ])
  expect(run.some(({ type }) => type === EventType.STEP_STARTED)).toBe(true)
  await stream.close()
  const other = keyFetch(url, await newKey(url, owner, 'elsewhere'))
  const theirs = Schema.decodeUnknownSync(TopicView)(
    await (await other('POST', '/api/topics', { name: 'Their customer', operationId: 'streams:other' })).json(),
  )
  for (const outside of [theirs.conversation, '1']) {
    const refused = await asKey('GET', `/api/conversations/${outside}/stream`)
    expect(refused.status).toBe(403)
    expect(refused.headers.get('content-type')).toContain('application/json')
    expect(await refused.json()).toMatchObject({ error: { code: 'access_insufficient' } })
  }
}

/**
 * A chat takes 32 readers at once; one more is refused as `stream_busy` (409), before anything is streamed. A Topic of
 * its own, so the case's earlier readers of Personal (gone, but the agent may not have been told yet) do not count.
 */
async function busy(url: string, owner: Person) {
  const topic = await callOwner(signedIn(url, owner), (api) =>
    api.topics.create({ payload: { name: 'Busy', operationId: crypto.randomUUID() } }),
  )
  const path = `/api/conversations/${topic.conversation}/stream`
  const readers: StreamRead[] = []
  try {
    for (let index = 0; index < 32; index += 1) readers.push(streamOf(await call(url, owner, path)))
    const refused = await call(url, owner, path)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'conflict', reason: 'stream_busy' } })
  } finally {
    await Promise.all(readers.map((reader) => reader.close()))
  }
}

/** The streams case (docs/architecture/streams.md). */
export async function streamsCase(url: string): Promise<void> {
  const owner = await person(url)
  const first = await memberReads(url, owner)
  await reconnect(url, owner, first)
  await keyReads(url, owner)
  await busy(url, owner)
}
