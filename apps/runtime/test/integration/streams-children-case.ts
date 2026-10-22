// A chat's children in its AG-UI stream on the real Worker and agent (docs/architecture/streams.md): a Persona the
// owner tags works in its fork, and the fork's work streams into the chat under its `subagentRunId` between
// SUBAGENT_STARTED and SUBAGENT_FINISHED, its answer after; a server's key reads the same of its room, the fork's own
// work included, and the stream agrees with the forward read; a subagent's run streams the same way, and a reader that
// connects while it works opens with it in flight.
import { type AguiEvent, ConversationEntries, EventType, TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, holding, lever, person, signedIn } from './owner-requests.ts'
import { ended, keyFetch, memberStream, newKey, ofType, streamOf } from './streams-case.ts'

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
  const stream = await memberStream(url, owner, '1')
  await stream.until((events) => events.length >= 2)
  const operationId = 'stream:persona'
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: runInput('1', {
        input: 'queue-hold:streamer plan it',
        operationId,
        selections: [{ kind: 'persona', personaId: persona.id }],
      }),
    }),
  )
  await holding(url, owner, 'queue-hold:streamer@Streamer')
  const begun = [...(await stream.until((events) => events.some(({ type }) => type === EventType.SUBAGENT_STARTED)))]
  const [started] = ofType(begun, EventType.SUBAGENT_STARTED)
  const fork = started?.subagentRunId ?? ''
  expect(started).toMatchObject({
    name: 'Streamer',
    metadata: {
      goblin: { persona: { id: persona.id, name: 'Streamer', operationId }, invocation: { state: 'running' } },
    },
  })
  expect(answerOf(begun, 'Streamer')).toBeUndefined()
  expect((await lever(url, owner, 'queue/release', { input: 'queue-hold:streamer@Streamer' })).status).toBe(200)
  const all = await stream.until(answered('Streamer'))
  await stream.close()
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
 * Swarmm's case: a server's key tags its own Persona in its room and reads the room's stream in full: the lifecycle,
 * with who answered for which operation, how it ended and the answer's entry; the fork's own work under its
 * `subagentRunId` between them; and the answer. The stream and the forward read name the same entry, invocation and
 * fork.
 */
async function personaInKeysRoom(url: string, owner: Person) {
  const asKey = keyFetch(url, await newKey(url, owner, 'children', ['topics', 'conversations', 'personas']))
  const json = async (method: string, path: string, body?: unknown) => {
    const response = await asKey(method, path, body)
    expect(response.status, await response.clone().text()).toBeLessThan(300)
    return response.json()
  }
  const persona = Schema.decodeUnknownSync(Made)(
    await json('POST', '/api/personas', { ...PERSONA, name: 'Relay', operationId: 'children:persona' }),
  )
  const topic = Schema.decodeUnknownSync(TopicView)(
    await json('POST', '/api/topics', { name: 'Child room', operationId: 'children:topic' }),
  )
  const room = topic.conversation
  const stream = streamOf(await asKey('GET', `/api/conversations/${room}/stream`))
  await stream.until((events) => events.length >= 2)
  const operationId = 'children:ask'
  await json(
    'POST',
    `/api/conversations/${room}/messages`,
    runInput(room, { input: 'find the venue', operationId, selections: [{ kind: 'persona', personaId: persona.id }] }),
  )
  const all = await stream.until(answered('Relay'))
  await stream.close()
  const [started] = ofType(all, EventType.SUBAGENT_STARTED)
  const fork = started?.subagentRunId ?? ''
  const mark = { id: persona.id, name: 'Relay', operationId }
  expect(started).toMatchObject({
    name: 'Relay',
    metadata: { goblin: { persona: mark, invocation: { state: 'running' } } },
  })
  // The fork's own work, in full: its prompt and its answer, under its id, between its start and its end.
  expect(childText(all, fork)).toContain("echo: Answer the owner's message above as @Relay.")
  const forks = all.filter((event) => 'subagentRunId' in event && event.subagentRunId === fork)
  expect(forks.length).toBeGreaterThan(2)
  expect([forks.at(0)?.type, forks.at(-1)?.type]).toEqual([EventType.SUBAGENT_STARTED, EventType.SUBAGENT_FINISHED])
  const [finished] = ofType(all, EventType.SUBAGENT_FINISHED)
  const answer = answerOf(all, 'Relay')
  expect(answer?.metadata).toMatchObject({ goblin: { subagentRunId: fork, persona: mark } })
  const read = Schema.decodeUnknownSync(ConversationEntries)(
    await json('GET', `/api/conversations/${room}/entries?after=0`),
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
 * The agent spawns a subagent (held at its model call) in the chat the owner follows; the run that spawned it ends,
 * and a reader that connects then opens with the subagent in flight. Released, its work ends, then its result arrives
 * naming it.
 */
async function subagentInOwnersChat(url: string, owner: Person) {
  const me = signedIn(url, owner)
  const first = await memberStream(url, owner, '1')
  await first.until((events) => events.length >= 2)
  const before = first.events.length
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'queue-hold:scout' })}`
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: runInput('1', { input: spawn, operationId: 'stream:spawn' }),
    }),
  )
  await holding(url, owner, 'queue-hold:scout')
  await first.until((events) => ended(events.slice(before)))
  await first.close()
  // A reader that connects now opens with the subagent at work.
  const stream = await memberStream(url, owner, '1')
  const begun = [
    ...(await stream.until((events) =>
      ofType(events, EventType.SUBAGENT_STARTED).some(({ name }) => name === 'scout'),
    )),
  ]
  const [started] = ofType(begun, EventType.SUBAGENT_STARTED)
  const scout = started?.subagentRunId ?? ''
  expect(started).toEqual({ type: EventType.SUBAGENT_STARTED, subagentRunId: scout, name: 'scout' })
  expect((await lever(url, owner, 'queue/release', { input: 'queue-hold:scout' })).status).toBe(200)
  const all = await stream.until((events) => result(events) !== undefined)
  await stream.close()
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
