// A chat's children in its AG-UI stream on the real Worker, agent and stream objects (docs/architecture/streams.md): a
// Persona the owner tags works in its fork, and the fork's work streams into the chat under its `subagentRunId`
// between SUBAGENT_STARTED and SUBAGENT_FINISHED, its answer after; a server's key reads the same of its room in the
// answers tier, the lifecycle and the answer alone, and the stream agrees with the forward read; a subagent's run
// streams the same way, and a new epoch opens with it in flight.
import { type AguiEvent, ConversationEntries, ConversationStream, EventType, TopicView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, call, holding, lever, ownerFetch, person, signedIn } from './owner-requests.ts'
import { Secret, join, moved, ofType, readOnce, readUntil } from './streams-case.ts'

const Made = Schema.Struct({ id: Schema.Int })

const PERSONA = {
  avatar: { glyph: 'S', hue: 30 },
  role: 'Streams its work',
  instructions: 'Be brief.',
  setup: { mcpServers: [], skills: [], apps: [] },
}

/** The events attributed to child `chat`, its lifecycle aside. */
const childEvents = (events: readonly AguiEvent[], chat: string) =>
  events.filter(
    (event) => 'subagentRunId' in event && event.subagentRunId === chat && !event.type.startsWith('SUBAGENT_'),
  )

/** The text of a child's answers, in order. */
const childText = (events: readonly AguiEvent[], chat: string) =>
  ofType(childEvents(events, chat), EventType.TEXT_MESSAGE_CONTENT)
    .map(({ delta }) => delta)
    .join('')

/** The answer a Persona named `name` wrote into the chat: its start, as the parent's own message. */
const answerOf = (events: readonly AguiEvent[], name: string) =>
  ofType(events, EventType.TEXT_MESSAGE_START).find((event) => event.role === 'assistant' && event.name === name)

/** Whether `events` hold a child's end and, after it, nothing more is awaited: a Persona's answer, written. */
const answered = (name: string) => (events: readonly AguiEvent[]) =>
  ofType(events, EventType.SUBAGENT_FINISHED).length > 0 && answerOf(events, name) !== undefined

/**
 * The owner tags a Persona in the chat they follow (its fork held at its model call): SUBAGENT_STARTED while it works,
 * then its own events under its `subagentRunId`, SUBAGENT_FINISHED naming its answer, and the answer itself, the
 * chat's own message naming the fork.
 */
async function personaInOwnersChat(url: string, owner: Person) {
  const me = signedIn(url, owner)
  const persona = await callOwner(me, (api) =>
    api.personas.create({ payload: { ...PERSONA, name: 'Streamer', operationId: crypto.randomUUID() } }),
  )
  const joined = await join(url, owner, '1')
  expect(joined.tier).toBe('full')
  const opening = await readOnce(url, joined.url, '-1')
  const operationId = 'stream:persona'
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: {
        input: 'queue-hold:streamer plan it',
        operationId,
        selections: [{ kind: 'persona', personaId: persona.id }],
      },
    }),
  )
  await holding(url, owner, 'queue-hold:streamer@Streamer')
  const begun = await readUntil(url, joined.url, opening.offset, (events) =>
    events.some(({ type }) => type === EventType.SUBAGENT_STARTED),
  )
  const [started] = ofType(begun.events, EventType.SUBAGENT_STARTED)
  const fork = started?.subagentRunId ?? ''
  expect(started).toMatchObject({
    name: 'Streamer',
    metadata: {
      goblin: { persona: { id: persona.id, name: 'Streamer', operationId }, invocation: { state: 'running' } },
    },
  })
  expect(answerOf(begun.events, 'Streamer')).toBeUndefined()
  expect((await lever(url, owner, 'queue/release', { input: 'queue-hold:streamer@Streamer' })).status).toBe(200)
  const rest = await readUntil(url, joined.url, begun.offset, answered('Streamer'))
  const all = [...begun.events, ...rest.events]
  // The fork's own work, under its id: its prompt and its answer, ids its own.
  expect(childText(all, fork)).toContain("echo: Answer the owner's message above as @Streamer.")
  for (const event of childEvents(all, fork))
    if ('messageId' in event) expect(event.messageId.startsWith(`${fork}:`)).toBe(true)
  const [finished] = ofType(all, EventType.SUBAGENT_FINISHED)
  const answer = answerOf(all, 'Streamer')
  const entryId = Number(answer?.metadata?.goblin?.entryId ?? answer?.messageId.split(':e')[1])
  expect(finished).toMatchObject({
    subagentRunId: fork,
    outcome: { type: 'success' },
    metadata: { goblin: { entryId, persona: { id: persona.id, operationId }, invocation: { state: 'answered' } } },
  })
  expect(answer).not.toHaveProperty('subagentRunId')
  expect(answer?.metadata).toMatchObject({ goblin: { subagentRunId: fork, persona: { operationId } } })
  // The forward read agrees: the invocation names the fork and the answer the stream named.
  const read = await callOwner(me, (api) => api.conversations.entries({ params: { id: '1' }, query: { after: 0 } }))
  expect(read.invocations).toContainEqual(
    expect.objectContaining({ operationId, fork, state: 'answered', answerEntry: entryId }),
  )
}

/**
 * Swarmm's case: a server's key tags its own Persona in its room and reads the room in the answers tier: the
 * lifecycle, with who answered for which operation, how it ended and the answer's entry, and the answer; none of the
 * fork's own work. The stream and the forward read name the same entry, invocation and fork.
 */
async function personaInKeysRoom(url: string, owner: Person) {
  const made = await call(url, owner, '/api/keys', {
    name: 'children',
    scopes: ['topics', 'conversations', 'personas'],
    servers: [],
    expiresInDays: 1,
  })
  expect(made.status, await made.clone().text()).toBe(201)
  const { secret } = Schema.decodeUnknownSync(Secret)(await made.json())
  const asKey = async (method: string, path: string, body?: unknown) => {
    const response = await ownerFetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(response.status, await response.clone().text()).toBeLessThan(300)
    return response.json()
  }
  const persona = Schema.decodeUnknownSync(Made)(
    await asKey('POST', '/api/personas', { ...PERSONA, name: 'Relay', operationId: 'children:persona' }),
  )
  const topic = Schema.decodeUnknownSync(TopicView)(
    await asKey('POST', '/api/topics', { name: 'Child room', operationId: 'children:topic' }),
  )
  const room = topic.conversation
  const joined = Schema.decodeUnknownSync(ConversationStream)(await asKey('GET', `/api/conversations/${room}/stream`))
  expect(joined.tier).toBe('answers')
  const opening = await readOnce(url, joined.url, '-1')
  const operationId = 'children:ask'
  await asKey('POST', `/api/conversations/${room}/messages`, {
    input: 'find the venue',
    operationId,
    selections: [{ kind: 'persona', personaId: persona.id }],
  })
  const run = await readUntil(url, joined.url, opening.offset, answered('Relay'))
  const all = [...opening.events, ...run.events]
  expect(all.filter((event) => 'subagentRunId' in event && !event.type.startsWith('SUBAGENT_'))).toEqual([])
  expect(all.filter(({ type }) => /^(?:REASONING_|TOOL_CALL_|STEP_)/u.test(type))).toEqual([])
  const [started] = ofType(all, EventType.SUBAGENT_STARTED)
  const fork = started?.subagentRunId ?? ''
  const mark = { id: persona.id, name: 'Relay', operationId }
  expect(started).toMatchObject({
    name: 'Relay',
    metadata: { goblin: { persona: mark, invocation: { state: 'running' } } },
  })
  const [finished] = ofType(all, EventType.SUBAGENT_FINISHED)
  const answer = answerOf(all, 'Relay')
  expect(answer?.metadata).toMatchObject({ goblin: { subagentRunId: fork, persona: mark } })
  const read = Schema.decodeUnknownSync(ConversationEntries)(
    await asKey('GET', `/api/conversations/${room}/entries?after=0`),
  )
  const entry = read.entries.find((each) => each.kind === 'persona' && each.operationId === operationId)
  expect(finished).toMatchObject({
    subagentRunId: fork,
    outcome: { type: 'success' },
    metadata: { goblin: { entryId: entry?.id, persona: mark, invocation: { state: 'answered' } } },
  })
  expect(read.invocations).toContainEqual(
    expect.objectContaining({ operationId, persona: persona.id, fork, state: 'answered', answerEntry: entry?.id }),
  )
}

/** A Delegate's result among `events`: what a subagent's report writes into its spawner's chat. */
const result = (events: readonly AguiEvent[]) =>
  ofType(events, EventType.ACTIVITY_SNAPSHOT).find(({ activityType }) => activityType === 'goblin.delegate_result')

/**
 * The agent spawns a subagent (held at its model call) in the chat the owner follows; the run that spawned it ends and
 * the stream moves on, so the next epoch opens with the subagent in flight. Released, its work ends, then its result
 * arrives naming it.
 */
async function subagentInOwnersChat(url: string, owner: Person) {
  const me = signedIn(url, owner)
  const joined = await join(url, owner, '1')
  const opening = await readOnce(url, joined.url, '-1')
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'queue-hold:scout' })}`
  await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: '1' }, payload: { input: spawn, operationId: 'stream:spawn' } }),
  )
  await holding(url, owner, 'queue-hold:scout')
  // The run that spawned it ended (the owner stack moves every stream at a run's end): the next epoch carries it.
  await readUntil(url, joined.url, opening.offset, moved)
  const next = await join(url, owner, '1')
  expect(next.epoch).toBeGreaterThan(joined.epoch)
  const begun = await readUntil(url, next.url, '-1', (events) =>
    ofType(events, EventType.SUBAGENT_STARTED).some(({ name }) => name === 'scout'),
  )
  const [started] = ofType(begun.events, EventType.SUBAGENT_STARTED)
  const scout = started?.subagentRunId ?? ''
  expect(started).toEqual({ type: EventType.SUBAGENT_STARTED, subagentRunId: scout, name: 'scout' })
  expect((await lever(url, owner, 'queue/release', { input: 'queue-hold:scout' })).status).toBe(200)
  const rest = await readUntil(url, next.url, begun.offset, (events) => result(events) !== undefined)
  const all = [...begun.events, ...rest.events]
  expect(childText(all, scout)).toContain('echo: queue-hold:scout')
  expect(ofType(all, EventType.SUBAGENT_FINISHED)).toEqual([
    { type: EventType.SUBAGENT_FINISHED, subagentRunId: scout, outcome: { type: 'success' } },
  ])
  const finishedAt = all.findIndex(({ type }) => type === EventType.SUBAGENT_FINISHED)
  expect(all.findIndex((event) => event === result(all))).toBeGreaterThan(finishedAt)
  expect(result(all)?.metadata).toMatchObject({ goblin: { subagentRunId: scout } })
}

/** The children case (docs/architecture/streams.md). */
export async function streamChildrenCase(url: string): Promise<void> {
  const owner = await person(url)
  await personaInOwnersChat(url, owner)
  await personaInKeysRoom(url, owner)
  await subagentInOwnersChat(url, owner)
}
