// Driving a chat with AG-UI on the real Worker and agent (ADR 0111, docs/architecture/streams.md "Driving a chat"): a
// send asked for server-sent events answers with the run that took it, under its own run id, which a stock client's
// verifier accepts; a queued send waits for its own run; a question is answered by a resume; an ask of Personas is a
// run of its own; a retry answers its end at once; a server's key sends as Swarmm does; a body of a whole history fits;
// and a stock `HttpAgent` runs a turn end to end.
import { HttpAgent, verifyEvents } from '@ag-ui/client'
import { type AguiEvent, EventType, MessageReceipt, StartedThread, TopicView, runInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { from, lastValueFrom, toArray } from 'rxjs'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import { type Person, call, holding, lever, ownerFetch, person, signedIn } from './owner-requests.ts'
import { ended, keyFetch, newKey, ofType, streamOf } from './streams-case.ts'

const SSE = { accept: 'text/event-stream' }

/** The events, once a stock client's `verifyEvents` accepted them all. */
async function verified(events: readonly AguiEvent[]): Promise<readonly AguiEvent[]> {
  await lastValueFrom(verifyEvents()(from(events)).pipe(toArray()))
  return events
}

/** `who` sends `body` into `chat` asking for its run as events: the whole run, verified, once it ended. */
async function driven(url: string, who: Person, chat: string, body: unknown): Promise<readonly AguiEvent[]> {
  const response = await call(url, who, `/api/conversations/${chat}/messages`, body, SSE)
  return verified(await streamOf(response).until(ended))
}

/** The text of the assistant's messages in `events`, in order. */
const said = (events: readonly AguiEvent[]): string =>
  ofType(events, EventType.TEXT_MESSAGE_CONTENT)
    .map(({ delta }) => delta)
    .join('')

/** A turn's run with its thinking and tool call, under the send's id; then the same send again, answered at once. */
async function runAndReplay(url: string, owner: Person): Promise<void> {
  const body = runInput('1', { input: 'think call subagent_status {}', operationId: 'drive:1' })
  const events = await driven(url, owner, '1', body)
  expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: '1', runId: 'drive:1' })
  expect(events[0]?.metadata).toMatchObject({ goblin: { run: expect.stringMatching(/^1:\d+$/u) } })
  expect(events[1]?.type).toBe(EventType.STATE_SNAPSHOT)
  expect(ofType(events, EventType.REASONING_MESSAGE_CONTENT).length).toBeGreaterThan(0)
  expect(ofType(events, EventType.TOOL_CALL_START)).toEqual([
    expect.objectContaining({ toolCallName: 'subagent_status' }),
  ])
  expect(ofType(events, EventType.TEXT_MESSAGE_START).every(({ role }) => role === 'assistant')).toBe(true)
  expect(said(events)).toMatch(/^done: /u)
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'drive:1', outcome: { type: 'success' } })
  const again = await driven(url, owner, '1', body)
  expect(again.map(({ type }) => type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
  expect(again[1]?.metadata).toMatchObject({ goblin: { replayed: { answers: [expect.any(Number)] } } })
  const receipt = await call(url, owner, '/api/conversations/1/messages', body)
  expect(Schema.decodeUnknownSync(MessageReceipt)(await receipt.json())).toMatchObject({ accepted: false })
}

/** A send queued behind a run in flight streams nothing of that run, only its own once it starts. */
async function queued(url: string, owner: Person): Promise<void> {
  const me = signedIn(url, owner)
  const hold = 'queue-hold:drive-first'
  await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: '1' }, payload: runInput('1', { input: hold, operationId: 'drive:2a' }) }),
  )
  await holding(url, owner, hold)
  const body = runInput('1', { input: 'the follow-up', operationId: 'drive:2b' })
  const stream = streamOf(await call(url, owner, '/api/conversations/1/messages', body, SSE))
  expect((await lever(url, owner, 'queue/release', { input: hold })).status).toBe(200)
  const events = await verified(await stream.until(ended))
  expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: 'drive:2b' })
  expect(said(events)).toBe('echo: the follow-up')
  expect(JSON.stringify(events)).not.toContain(`echo: ${hold}`)
}

/** A run that asks ends on its question, and the next send answers it with a resume alone. */
async function resumed(url: string, owner: Person): Promise<void> {
  const question = { questions: [{ id: 'size', prompt: 'Which size?', kind: 'text' }] }
  const asking = runInput('1', { input: `call ask_user ${JSON.stringify(question)}`, operationId: 'drive:3a' })
  const asked = (await driven(url, owner, '1', asking)).at(-1)
  if (asked?.type !== EventType.RUN_FINISHED || asked.outcome?.type !== 'interrupt') throw new Error('no question')
  const [interrupt] = asked.outcome.interrupts
  expect(interrupt).toMatchObject({ reason: 'question', id: expect.stringMatching(/^1:i\d+$/u) })
  const elsewhere = { threadId: '1', runId: 'drive:3x', messages: [] }
  const unknown = await call(url, owner, '/api/conversations/1/messages', {
    ...elsewhere,
    resume: [{ interruptId: '1:i999999', status: 'resolved', payload: 'x' }],
  })
  expect(await unknown.json()).toMatchObject({ error: { reason: 'interrupt_not_open' } })
  const answer = {
    threadId: '1',
    runId: 'drive:3b',
    messages: [],
    resume: [{ interruptId: interrupt?.id, status: 'resolved', payload: 'Square' }],
  }
  const events = await driven(url, owner, '1', answer)
  expect(said(events)).toBe('echo: Square')
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } })
}

/** An ask of a Persona is a run of its own: its answer, then its end once the invocation settled; a retry, at once. */
async function personaAsk(url: string, owner: Person): Promise<void> {
  const me = signedIn(url, owner)
  const made = await callOwner(me, (api) =>
    api.personas.create({
      payload: {
        name: 'Driver',
        avatar: { glyph: 'D', hue: 30 },
        role: 'Drives runs',
        instructions: 'Answer briefly.',
        setup: { mcpServers: [], skills: [], apps: [] },
        operationId: 'drive:persona',
      },
    }),
  )
  const selections = [{ kind: 'persona' as const, personaId: made.id }]
  const body = runInput('1', { input: 'plan it', operationId: 'drive:4', selections })
  const events = await driven(url, owner, '1', body)
  expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: 'drive:4' })
  expect(ofType(events, EventType.TEXT_MESSAGE_START)).toEqual([
    expect.objectContaining({ role: 'assistant', name: 'Driver' }),
  ])
  expect(events.some(({ type }) => type.startsWith('SUBAGENT_'))).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'drive:4', outcome: { type: 'success' } })
  const again = await driven(url, owner, '1', body)
  expect(again.at(-1)?.metadata).toMatchObject({ goblin: { replayed: { answers: [expect.any(Number)] } } })
}

/** A server's key sends as Swarmm does: AG-UI bodies written by hand, a Persona tag in `forwardedProps.goblin`. */
async function keySends(url: string, owner: Person): Promise<void> {
  const asKey = keyFetch(url, await newKey(url, owner, 'drive'))
  const topic = Schema.decodeUnknownSync(TopicView)(
    await (await asKey('POST', '/api/topics', { name: 'Driven room', operationId: 'drive:topic' })).json(),
  )
  const persona = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(
    await (
      await asKey('POST', '/api/personas', {
        name: 'Roomer',
        avatar: { glyph: 'R', hue: 90 },
        role: 'Answers the room',
        instructions: 'Be brief.',
        operationId: 'drive:roomer',
      })
    ).json(),
  )
  const chat = topic.conversation
  const sent = await asKey('POST', `/api/conversations/${chat}/messages`, {
    threadId: chat,
    runId: 'swarmm-msg-1',
    messages: [{ id: 'swarmm-msg-1', role: 'user', content: 'Can you design my cover?' }],
    forwardedProps: { goblin: { selections: [{ kind: 'persona', personaId: persona.id }] } },
  })
  expect(sent.status, await sent.clone().text()).toBe(202)
  expect(Schema.decodeUnknownSync(MessageReceipt)(await sent.json())).toMatchObject({ operationId: 'swarmm-msg-1' })
  const started = await asKey('POST', `/api/conversations/${chat}/threads`, {
    anchor: 'latest',
    title: 'Job 1',
    message: {
      threadId: chat,
      runId: 'swarmm-job-1',
      messages: [{ id: 'swarmm-job-1', role: 'user', content: 'Accepted. Do the work now.' }],
      forwardedProps: { goblin: { selections: [{ kind: 'persona', personaId: persona.id }] } },
    },
  })
  expect(started.status, await started.clone().text()).toBe(201)
  expect(Schema.decodeUnknownSync(StartedThread)(await started.json()).receipt.operationId).toBe('swarmm-job-1:first')
}

/** A stock client's body carries the whole history: up to 1 MiB is taken, past it is refused at the edge. */
async function wholeHistory(url: string, owner: Person): Promise<void> {
  const earlier = Array.from({ length: 300 }, (_, index) => ({
    id: `h${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(1000),
  }))
  const body = { threadId: '1', runId: 'drive:5', messages: [...earlier, { id: 'last', role: 'user', content: 'hi' }] }
  expect(JSON.stringify(body).length).toBeGreaterThan(65_536)
  const sent = await call(url, owner, '/api/conversations/1/messages', body)
  expect(sent.status, await sent.clone().text()).toBe(202)
  const huge = { ...body, runId: 'drive:6', messages: [{ id: 'big', role: 'user', content: 'x'.repeat(1_100_000) }] }
  expect((await call(url, owner, '/api/conversations/1/messages', huge)).status).toBe(413)
}

/** A stock `HttpAgent` drives its key's room with the key: one turn, its events verified by the client itself. */
async function stockAgent(url: string, owner: Person): Promise<void> {
  const secret = await newKey(url, owner, 'stock')
  const topic = Schema.decodeUnknownSync(TopicView)(
    await (
      await keyFetch(url, secret)('POST', '/api/topics', { name: 'Stock room', operationId: 'stock:topic' })
    ).json(),
  )
  const room = topic.conversation
  const agent = new HttpAgent({
    url: `${url}/api/conversations/${room}/messages`,
    headers: { authorization: `Bearer ${secret}` },
    threadId: room,
    fetch: (target, init) => ownerFetch(target, init),
  })
  agent.addMessage({ id: 'stock-1', role: 'user', content: 'hello from a stock client' })
  await agent.runAgent({ runId: 'stock:1' })
  expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'echo: hello from a stock client' })
}

/** The AG-UI send case (ADR 0111). */
export async function runStreamsCase(url: string): Promise<void> {
  const owner = await person(url)
  await runAndReplay(url, owner)
  await queued(url, owner)
  await resumed(url, owner)
  await personaAsk(url, owner)
  await keySends(url, owner)
  await wholeHistory(url, owner)
  await stockAgent(url, owner)
}
