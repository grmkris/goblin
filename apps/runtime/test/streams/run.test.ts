// One send's run (ADR 0111, docs/architecture/streams.md "Driving a chat") over the recorded Pi batches (`fixtures/`):
// every case's events are valid AG-UI 1.0 with goblin's parts by their contracts (`checked`), and pass `@ag-ui/client`'s
// own verifier, which a stock client runs: RUN_STARTED first, nothing open at RUN_FINISHED, no subagent at work.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyEvents } from '@ag-ui/client'
import type { AgentEvent, SnapshotEvent, SubmissionRecord } from '@earendil-works/pi-durable'
import { type AguiEvent, EventType, type PersonaInvocationView } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { from, lastValueFrom, toArray } from 'rxjs'
import { translate } from '../../src/streams/agui.ts'
import { opening } from '../../src/streams/bodies.ts'
import { RunFollow, type RunTarget } from '../../src/streams/run.ts'
import { checked, replay, textOf } from './agui-check.ts'
import type { Recording, ScenarioName } from './scenarios.ts'

const fixture = (name: ScenarioName): Recording =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url).href), 'utf8'))

/** A conversation with nothing in it yet: what a watch that began before the recorded run opened with. */
const EMPTY: SnapshotEvent = {
  type: 'snapshot',
  entries: [],
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
}

/** The record of operation `requestId` in `batches` with `status`, as Pi handed it over. */
function recordOf(batches: Recording['batches'], requestId: string, status: SubmissionRecord['status']) {
  for (const event of batches.flat())
    if (event.type === 'submission' && event.record.requestId === requestId && event.record.status === status)
      return event.record
  throw new Error(`no ${status} record of ${requestId}`)
}

/** The events, once a stock client's `verifyEvents` accepted them all; the first it refuses fails the test. */
async function verified(events: readonly AguiEvent[]): Promise<readonly AguiEvent[]> {
  await lastValueFrom(verifyEvents()(from(checked(events))).pipe(toArray()))
  return events
}

const types = (events: readonly AguiEvent[]) => events.map(({ type }) => type)
const send = (runId: string, ask = false): RunTarget => ({ chat: '1', runId, ask })

/** The tool calls, their results and the text among `list`: what a turn says. */
const own = (list: readonly AguiEvent[]) =>
  list.filter(({ type }) =>
    [EventType.TOOL_CALL_START, EventType.TOOL_CALL_RESULT, EventType.TEXT_MESSAGE_CONTENT].includes(type),
  )

/** The `persona` recording's Persona's invocation of `op-persona`, as `change` leaves it. */
const invocation = (change: Partial<PersonaInvocationView>): PersonaInvocationView => ({
  operationId: 'op-persona',
  persona: 4,
  revision: 2,
  chat: '1',
  order: 0,
  state: 'running',
  createdAt: 1,
  ...change,
})

/** `follow` fed `batches` in order: everything it sends. */
function feed(follow: RunFollow, batches: readonly (readonly AgentEvent[])[]): AguiEvent[] {
  return batches.flatMap((batch) => follow.batch(batch))
}

describe("a send's run (ADR 0111)", () => {
  it.each(['plain', 'reasoning', 'tool', 'error', 'aborted'] as const)(
    '%s: the run that took the input, under the send’s ids, without the send’s own message',
    async (name) => {
      const { batches } = fixture(name)
      const operation = `op-${name === 'aborted' ? 'abort' : name}`
      const follow = new RunFollow(send(operation), opening('1', EMPTY))
      expect(follow.admitted(undefined, recordOf(batches, operation, 'placed'))).toEqual([])
      const events = await verified(feed(follow, batches))
      expect(follow.done).toBe(true)
      expect(events[0]).toEqual({
        type: EventType.RUN_STARTED,
        threadId: '1',
        runId: operation,
        metadata: { goblin: { run: '1:8', operations: [operation] } },
      })
      expect(events[1]?.type).toBe(EventType.STATE_SNAPSHOT)
      const starts = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)
      expect(starts.every((event) => event.type === EventType.TEXT_MESSAGE_START && event.role === 'assistant')).toBe(
        true,
      )
      const end = events.at(-1)
      if (name === 'error') expect(end).toMatchObject({ type: EventType.RUN_ERROR, code: 'model_error' })
      else
        expect(end).toMatchObject({
          type: EventType.RUN_FINISHED,
          runId: operation,
          outcome: { type: name === 'aborted' ? 'cancelled' : 'success' },
        })
    },
  )

  it('carries the thinking, the tool call with its result and the answer, as the chat stream has them', async () => {
    const { batches } = fixture('tool')
    const follow = new RunFollow(send('op-tool'), opening('1', EMPTY))
    follow.admitted(undefined, recordOf(batches, 'op-tool', 'placed'))
    const events = await verified(feed(follow, batches))
    const chat = replay(opening('1', EMPTY).cursor, batches).events
    expect(own(events)).toEqual(own(chat).filter((event) => !('messageId' in event) || !event.messageId.includes(':e')))
  })

  it('waits while another run is in flight, and follows its own run once it starts', async () => {
    const { batches } = fixture('queue')
    // The watch began during the first run, before the follow-up was admitted.
    const before = replay(opening('1', EMPTY).cursor, batches.slice(0, 3))
    const follow = new RunFollow(send('op-second'), { events: [], cursor: before.cursor })
    expect(follow.admitted(undefined, recordOf(batches, 'op-second', 'queued'))).toEqual([])
    const events = await verified(feed(follow, batches.slice(3)))
    expect(events[0]).toMatchObject({ runId: 'op-second', metadata: { goblin: { run: '1:11' } } })
    expect(textOf(events, events.find((e) => e.type === EventType.TEXT_MESSAGE_START)?.messageId ?? '')).toBe(
      'Second answer.',
    )
    expect(JSON.stringify(events)).not.toContain('First answer.')
  })

  it('opens a retry of a send whose run is under way with that run, its answer so far included', async () => {
    const { batches, mid } = fixture('overflow')
    if (mid === undefined) throw new Error('the overflow fixture has no mid-answer snapshot')
    const record = recordOf(batches, 'op-count', 'placed')
    const follow = new RunFollow(send('op-count'), opening('1', mid.snapshot))
    const opened = follow.admitted(record, record)
    expect(types(opened).slice(0, 3)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
    ])
    const events = await verified([...opened, ...feed(follow, batches.slice(mid.after))])
    const answer = events.find((e) => e.type === EventType.TEXT_MESSAGE_START)?.messageId ?? ''
    expect(textOf(events, answer)).toBe('One two three four')
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'op-count' })
  })

  it('joins the run in flight from what is open in it, when its input is placed there', async () => {
    const { batches } = fixture('queue')
    // The follow-up, placed into the first run while its answer streams (as a steer would be), joins that run.
    const before = replay(opening('1', EMPTY).cursor, batches.slice(0, 3))
    const follow = new RunFollow(send('op-second'), { events: [], cursor: before.cursor })
    expect(follow.admitted(undefined, recordOf(batches, 'op-second', 'queued'))).toEqual([])
    const placed: AgentEvent = { type: 'submission', record: recordOf(batches, 'op-second', 'placed') }
    const joined = follow.batch([placed])
    expect(types(joined)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.STEP_STARTED,
      EventType.TEXT_MESSAGE_START,
    ])
    const events = await verified([...joined, ...feed(follow, batches.slice(4))])
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'op-second' })
    expect(follow.done).toBe(true)
  })

  it('ends with the questions a run asked, and only those', async () => {
    const { batches } = fixture('question')
    const follow = new RunFollow(send('op-question'), opening('1', EMPTY))
    follow.admitted(undefined, recordOf(batches, 'op-question', 'placed'))
    const end = (await verified(feed(follow, batches))).at(-1)
    expect(end).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'interrupt', interrupts: [expect.objectContaining({ reason: 'question' })] },
    })
  })

  it('answers a retry of a send that ended with its end at once, naming its entries', async () => {
    const { batches } = fixture('plain')
    const done = recordOf(batches, 'op-plain', 'done')
    const follow = new RunFollow(send('op-plain'), opening('1', EMPTY))
    const events = await verified(follow.admitted(done, done))
    expect(follow.done).toBe(true)
    expect(types(events)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
    expect(events[1]).toMatchObject({
      outcome: { type: 'success' },
      metadata: { goblin: { replayed: { entry: Number(done.entry), answers: [Number(done.answer)] } } },
    })
    const failed = recordOf(fixture('error').batches, 'op-error', 'unanswered')
    const again = new RunFollow(send('op-error'), opening('1', EMPTY)).admitted(failed, failed)
    expect(types(await verified(again))).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR])
  })

  it('ends in error when the input is withdrawn before a run took it', async () => {
    const { batches } = fixture('aborted')
    const follow = new RunFollow(send('op-abort'), opening('1', EMPTY))
    follow.admitted(undefined, recordOf(batches, 'op-abort', 'placed'))
    const withdrawn: AgentEvent = { type: 'submission', record: recordOf(batches, 'op-abort', 'unanswered') }
    const events = await verified(follow.batch([withdrawn]))
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: '1', runId: 'op-abort' },
      { type: EventType.RUN_ERROR, code: 'withdrawn', message: 'withdrawn' },
    ])
  })

  it('ends a send whose run never came, at the stream’s life, as an error a stock client accepts', async () => {
    const { batches } = fixture('queue')
    const follow = new RunFollow(send('op-second'), opening('1', EMPTY))
    follow.admitted(undefined, recordOf(batches, 'op-second', 'queued'))
    const events = await verified(follow.ended('stream_lifetime'))
    expect(types(events)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR])
    expect(follow.ended('stream_ended')).toEqual([])
  })
})

describe('an ask of Personas as a run (ADR 0111)', () => {
  /** The `persona` recording's first answer, entry by entry, and its invocation. */
  const persona = fixture('persona')
  const answerEntry = (index: number) => {
    const event = persona.batches[index]?.find(({ type }) => type === 'message_end')
    if (event?.type !== 'message_end') throw new Error('no answer')
    return Number(event.entry.id)
  }

  it('starts at once, carries its own Persona’s answer, and ends when its invocations settle', async () => {
    const follow = new RunFollow(send('op-persona', true), opening('1', EMPTY))
    const opened = follow.admitted(undefined, undefined)
    expect(types(opened)).toEqual([EventType.RUN_STARTED, EventType.STATE_SNAPSHOT])
    const carried = feed(follow, persona.batches)
    expect(follow.invocations([invocation({ state: 'running' })])).toEqual([])
    const end = follow.invocations([invocation({ state: 'answered', answerEntry: answerEntry(1) })])
    const events = await verified([...opened, ...carried, ...end])
    const [answer] = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)
    expect(answer).toMatchObject({ role: 'assistant', name: 'Squarewave' })
    expect(textOf(events, answer?.type === EventType.TEXT_MESSAGE_START ? answer.messageId : '')).toBe(
      'Here is the plan.',
    )
    // The other operation's answer (held for a grant) is not this send's; the chat's STATE still shows its hold.
    expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: 'op-persona',
      outcome: { type: 'success' },
    })
  })

  it('waits for an answer it has not carried yet, and ends on the owner when the answer asked', async () => {
    const asked = persona.batches[1]?.map((event) =>
      event.type === 'message_end' && event.entry.kind === 'app.persona'
        ? {
            ...event,
            entry: {
              ...event.entry,
              data: { ...Object(event.entry.data), questions: [{ id: 'when', prompt: 'When?', kind: 'text' }] },
            },
          }
        : event,
    )
    const follow = new RunFollow(send('op-persona', true), opening('1', EMPTY))
    const opened = follow.admitted(undefined, undefined)
    const settled = [invocation({ state: 'answered', answerEntry: answerEntry(1) })]
    expect(follow.invocations(settled)).toEqual([])
    const events = await verified([
      ...opened,
      ...feed(follow, [persona.batches[0] ?? [], asked ?? []]),
      ...follow.invocations(settled),
    ])
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: 'interrupt',
        interrupts: [expect.objectContaining({ reason: 'question', message: expect.stringContaining('When?') })],
      },
    })
  })

  it('fails when no Persona answered, is cancelled when they were stopped, and a retry names its answers', async () => {
    const failing = new RunFollow(send('op-persona', true), opening('1', EMPTY))
    const failed = [
      ...failing.admitted(undefined, undefined),
      ...failing.invocations([invocation({ state: 'failed', reason: 'model_error' })]),
    ]
    expect((await verified(failed)).at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'model_error' })
    const stopping = new RunFollow(send('op-persona', true), opening('1', EMPTY))
    const stopped = [
      ...stopping.admitted(undefined, undefined),
      ...stopping.invocations([invocation({ state: 'stopped' })]),
    ]
    expect((await verified(stopped)).at(-1)).toMatchObject({ outcome: { type: 'cancelled' } })
    // A retry after the answers were written: the opening already holds them.
    const after = replay(opening('1', EMPTY).cursor, persona.batches.slice(0, 2))
    const retry = new RunFollow(send('op-persona', true), { events: [], cursor: after.cursor })
    const prior = recordOf(persona.batches, 'ask-1', 'done')
    const replayed = [
      ...retry.admitted(prior, prior),
      ...retry.invocations([invocation({ state: 'answered', answerEntry: answerEntry(1) })]),
    ]
    expect((await verified(replayed)).at(-1)).toMatchObject({
      metadata: { goblin: { replayed: { answers: [answerEntry(1)] } } },
    })
  })

  it('never carries a fork’s own work', () => {
    const { batches } = fixture('fork')
    const follow = new RunFollow(send('op-fork', true), opening('1', EMPTY))
    const events = [...follow.admitted(undefined, undefined), ...feed(follow, batches)]
    expect(events.some((event) => 'subagentRunId' in event && event.subagentRunId !== undefined)).toBe(false)
    expect(translate(opening('1', EMPTY).cursor, batches[0] ?? []).events.length).toBeGreaterThan(0)
  })
})
