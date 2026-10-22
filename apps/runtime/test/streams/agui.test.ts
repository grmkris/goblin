// Golden tests of the AG-UI translator over Pi batches recorded on a real Pi Harness (`scenarios.ts`, `fixtures/`).
// Each case's whole output (both tiers, and an epoch opened on the idle conversation) is kept in `__snapshots__/` and
// reviewed as the public profile's examples; the assertions name what each case is for.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AguiEvent, EventType } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { open, reconcile, startCursor, translate } from '../../src/streams/agui.ts'
import { coalesce, forTier } from '../../src/streams/tiers.ts'
import { checked, replay, textOf } from './agui-check.ts'
import type { Recording, ScenarioName } from './scenarios.ts'

const fixture = (name: ScenarioName): Recording =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url).href), 'utf8'))

/** A recording translated from a fresh stream, checked, and kept as its golden. */
async function golden(name: ScenarioName) {
  const recording = fixture(name)
  const { events, cursor } = replay(startCursor(recording.chat), recording.batches)
  const answers = forTier(checked(events), 'answers')
  const opened = open(recording.chat, recording.final, { window: 50 }).events
  checked(forTier(opened, 'answers'), 'answers')
  const kept = { full: events, answers: checked(answers, 'answers'), open: checked(opened) }
  await expect(`${JSON.stringify(kept, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/${name}.agui.json`)
  return { events, answers, cursor, recording }
}

const ofType = <T extends EventType>(events: readonly AguiEvent[], type: T) =>
  events.filter((event): event is Extract<AguiEvent, { type: T }> => event.type === type)

/** The assistant messages' ids, in the order they start. */
const assistantIds = (events: readonly AguiEvent[]) =>
  ofType(events, EventType.TEXT_MESSAGE_START).flatMap((event) => (event.role === 'assistant' ? [event.messageId] : []))

describe('a chat as AG-UI events', () => {
  it('streams a plain reply inside its run, the input first', async () => {
    const { events, recording } = await golden('plain')
    const types = events.map(({ type }) => type)
    expect(types.slice(0, 5)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_STARTED,
    ])
    const [started] = ofType(events, EventType.RUN_STARTED)
    expect(started).toMatchObject({ threadId: '1', runId: '1:8', metadata: { goblin: { operations: ['op-plain'] } } })
    const [reply] = assistantIds(events)
    expect(reply).toMatch(/^1:a\d+$/u)
    expect(textOf(events, reply ?? '')).toBe('Hello there, friend.')
    expect(ofType(events, EventType.TEXT_MESSAGE_CONTENT).filter((event) => event.messageId === reply)).toHaveLength(3)
    const end = ofType(events, EventType.TEXT_MESSAGE_END).find((event) => event.messageId === reply)
    expect(end?.metadata).toEqual({ goblin: { entryId: 11 } })
    // The id the answer streamed under is the one an epoch's snapshot gives the committed message.
    const [snapshot] = ofType(open('1', recording.final, { window: 50 }).events, EventType.MESSAGES_SNAPSHOT)
    expect(snapshot?.messages.map(({ id }) => id)).toEqual(['1:e7', reply])
    expect(ofType(events, EventType.RUN_FINISHED).at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: '1:8',
      outcome: { type: 'success' },
      usage: [{ provider: 'fixture', model: 'lifecycle-fixture', inputTokens: 12, outputTokens: 5, totalTokens: 17 }],
    })
  })

  it('sends visible thinking as a reasoning message in its own span, before the answer', async () => {
    const { events, answers } = await golden('reasoning')
    const [reply] = assistantIds(events)
    const thought = `${reply}:r0`
    expect(textOf(events, thought)).toBe('Two and two.')
    expect(textOf(events, reply ?? '')).toBe('It is four.')
    const order = events.flatMap((event) =>
      'messageId' in event && event.messageId.startsWith(reply ?? '-') ? [`${event.type} ${event.messageId}`] : [],
    )
    expect(order.slice(0, 4)).toEqual([
      `REASONING_START ${reply}:s0`,
      `REASONING_MESSAGE_START ${thought}`,
      `REASONING_MESSAGE_CONTENT ${thought}`,
      `REASONING_MESSAGE_CONTENT ${thought}`,
    ])
    expect(answers.some(({ type }) => type.startsWith('REASONING'))).toBe(false)
    expect(textOf(answers, reply ?? '')).toBe('It is four.')
  })

  it('opens a tool call as it streams, sends its arguments once, then its progress and result', async () => {
    const { events, answers } = await golden('tool')
    const [first, second] = assistantIds(events)
    expect(ofType(events, EventType.TOOL_CALL_START)).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: 'call-1', toolCallName: 'forecast', parentMessageId: first },
    ])
    expect(ofType(events, EventType.TOOL_CALL_ARGS)).toEqual([
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-1', delta: '{"city":"Tallinn"}' },
    ])
    const progress = ofType(events, EventType.CUSTOM).map(({ name, value }) => ({ name, value }))
    expect(progress).toEqual([
      { name: 'goblin.tool_progress', value: { toolCallId: 'call-1', status: 'running' } },
      { name: 'goblin.tool_progress', value: { toolCallId: 'call-1', output: { set: 'Looking up ' } } },
      { name: 'goblin.tool_progress', value: { toolCallId: 'call-1', details: { kind: 'forecast', step: 1 } } },
      { name: 'goblin.tool_progress', value: { toolCallId: 'call-1', output: { append: 'Tallinn' } } },
    ])
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([
      expect.objectContaining({
        messageId: '1:tcall-1',
        toolCallId: 'call-1',
        content: 'Tallinn: sunny',
        metadata: {
          goblin: expect.objectContaining({ isError: false, details: expect.objectContaining({ kind: 'forecast' }) }),
        },
      }),
    ])
    expect(ofType(events, EventType.STEP_STARTED).map(({ stepName }) => stepName)).toEqual(['turn 1', 'turn 2'])
    expect(textOf(events, second ?? '')).toBe('It is sunny.')
    expect(answers.filter(({ type }) => type.startsWith('TOOL_CALL') || type.startsWith('STEP'))).toEqual([])
    expect(ofType(answers, EventType.CUSTOM)).toEqual([])
    expect(textOf(answers, first ?? '')).toBe('Checking.')
  })

  it("carries a member's message as their words, with who wrote it and the files it brought", async () => {
    const { events } = await golden('attachments')
    const [start] = ofType(events, EventType.TEXT_MESSAGE_START)
    expect(start).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      messageId: '1:e7',
      role: 'user',
      name: 'Ada',
      metadata: {
        goblin: {
          entryId: 7,
          at: 1760000000021,
          attachments: [{ path: '/uploads/plan.pdf', name: 'plan.pdf', size: 1024, mimeType: 'application/pdf' }],
          member: { name: 'Ada', userId: 'user-1' },
        },
      },
    })
    expect(textOf(events, '1:e7')).toBe('Here is the plan')
  })

  it('ends a run that asked the owner with the interrupt outcome, and keeps the question in /attention', async () => {
    const { events, answers } = await golden('question')
    const interrupt = {
      id: '1:i13',
      reason: 'question',
      message: 'Which size?',
      toolCallId: 'call-q',
      metadata: { goblin: { entryId: 13, questions: [expect.objectContaining({ id: 'size' })] } },
    }
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'interrupt', interrupts: [interrupt] },
    })
    const attention = ofType(answers, EventType.STATE_DELTA)
    expect(attention).toEqual([
      expect.objectContaining({ delta: [{ op: 'replace', path: '/attention', value: [interrupt] }] }),
    ])
    expect(answers.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } })
  })

  it('ends a stopped run as cancelled, its partial answer marked', async () => {
    const { events } = await golden('aborted')
    const [reply] = assistantIds(events)
    expect(textOf(events, reply ?? '')).toBe('Starting')
    const end = ofType(events, EventType.TEXT_MESSAGE_END).find((event) => event.messageId === reply)
    expect(end?.metadata).toEqual({ goblin: { entryId: 11, stop: { reason: 'aborted' } } })
    expect(ofType(events, EventType.RUN_FINISHED)).toEqual([
      expect.objectContaining({ outcome: { type: 'cancelled' } }),
    ])
  })

  it('ends a run whose model call failed with RUN_ERROR, after the retry it waited for', async () => {
    const { events } = await golden('error')
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: '503 Service Unavailable: overloaded',
      code: 'model_error',
      usage: expect.any(Array),
    })
    const generation = ofType(events, EventType.STATE_DELTA).flatMap(({ delta }) =>
      delta.flatMap((op) => (op.path === '/generation' && op.op === 'replace' ? [op.value] : [])),
    )
    expect(generation).toContainEqual({
      attempt: 1,
      retry: { at: expect.any(Number), error: '503 Service Unavailable: overloaded' },
    })
    expect(generation.at(-1)).toBeNull()
  })

  it("writes a Persona's answer as an assistant message in its name, and its hold as attention", async () => {
    const { events } = await golden('persona')
    expect(ofType(events, EventType.RUN_STARTED)).toEqual([])
    const starts = ofType(events, EventType.TEXT_MESSAGE_START)
    expect(starts.map(({ messageId, role, name }) => ({ messageId, role, name }))).toEqual([
      { messageId: '1:e7', role: 'user', name: undefined },
      { messageId: '1:e9', role: 'assistant', name: 'Squarewave' },
      { messageId: '1:e11', role: 'assistant', name: 'Squarewave' },
    ])
    expect(textOf(events, '1:e7')).toBe('plan the launch')
    expect(starts[0]?.metadata).toMatchObject({ goblin: { ask: { order: 'parallel' } } })
    expect(starts[1]?.metadata).toMatchObject({
      goblin: { persona: { id: 4, revision: 2, operationId: 'op-persona' } },
    })
    const attention = ofType(events, EventType.STATE_DELTA).at(-1)
    expect(attention?.delta).toEqual([
      {
        op: 'replace',
        path: '/attention',
        value: [
          {
            id: '1:i11',
            reason: 'grant',
            message: 'Squarewave: calendar · events_list',
            metadata: {
              goblin: { entryId: 11, persona: 4, fork: '12', connectionId: 'calendar', name: 'events_list' },
            },
          },
        ],
      },
    ])
  })

  it('sends the entries the app draws as activities, and a shared note as a user message from its thread', async () => {
    const { events } = await golden('activities')
    expect(
      ofType(events, EventType.ACTIVITY_SNAPSHOT).map(({ messageId, activityType }) => [messageId, activityType]),
    ).toEqual([
      ['1:e7', 'goblin.thread_head'],
      ['1:e9', 'goblin.notice'],
      ['1:e11', 'goblin.delegate_result'],
    ])
    const [shared] = ofType(events, EventType.TEXT_MESSAGE_START)
    expect(shared).toMatchObject({ messageId: '1:e13', role: 'user', metadata: { goblin: { thread: '7' } } })
  })

  it('queues a follow-up, then runs it as its own run with its operation', async () => {
    const { events } = await golden('queue')
    const queue = ofType(events, EventType.STATE_DELTA).flatMap(({ delta }) =>
      delta.flatMap((op) => (op.path === '/queue' && op.op === 'replace' ? [op.value] : [])),
    )
    expect(queue).toEqual([[{ id: 11, mode: 'followUp' }], []])
    const lifecycle = events.flatMap((event) =>
      event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED
        ? [`${event.type} ${event.runId}`]
        : event.type === EventType.TEXT_MESSAGE_START && event.role === 'user'
          ? [`user ${event.messageId}`]
          : [],
    )
    expect(lifecycle).toEqual([
      'RUN_STARTED 1:8',
      'user 1:e7',
      'RUN_FINISHED 1:8',
      'RUN_STARTED 1:11',
      'user 1:e13',
      'RUN_FINISHED 1:11',
    ])
    expect(ofType(events, EventType.RUN_STARTED)[1]?.metadata).toEqual({ goblin: { operations: ['op-second'] } })
  })
})

describe('catching up', () => {
  it('reconciles an overflow mid-answer without sending any text twice', async () => {
    const { recording } = await golden('overflow')
    const { mid, batches, chat } = recording
    if (mid === undefined) throw new Error('the overflow fixture has no mid-answer snapshot')
    // The last batch delivered before the snapshot is lost to the overflow; Pi delivers its snapshot instead.
    const before = replay(startCursor(chat), batches.slice(0, mid.after - 1))
    const caught = reconcile(before.cursor, mid.snapshot)
    const after = replay(caught.cursor, batches.slice(mid.after))
    const events = checked([...before.events, ...caught.events, ...after.events])
    const [reply] = assistantIds(events)
    expect(textOf(before.events, reply ?? '')).toBe('One')
    expect(textOf(caught.events, reply ?? '')).toBe(' two')
    expect(textOf(events, reply ?? '')).toBe('One two three four')
    // Pi's own form of an overflow, a snapshot event inside a batch, is the same catch-up.
    expect(translate(before.cursor, [mid.snapshot]).events).toEqual(caught.events)
  })

  it('opens an epoch mid-answer with the snapshots, the run and the answer so far, then goes on', async () => {
    const { mid, batches, chat } = fixture('overflow')
    if (mid === undefined) throw new Error('the overflow fixture has no mid-answer snapshot')
    const opened = open(chat, mid.snapshot, { window: 50 })
    const types = opened.events.map(({ type }) => type)
    expect(types).toEqual([
      EventType.MESSAGES_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ])
    const [messages] = ofType(opened.events, EventType.MESSAGES_SNAPSHOT)
    expect(messages?.messages).toEqual([
      { id: '1:e7', role: 'user', content: 'count', metadata: { goblin: { entryId: 7, at: 1760000000021 } } },
    ])
    const rest = replay(opened.cursor, batches.slice(mid.after))
    const events = checked([...opened.events, ...rest.events])
    const [reply] = assistantIds(events)
    expect(textOf(events, reply ?? '')).toBe('One two three four')
    expect(ofType(events, EventType.TEXT_MESSAGE_START)).toHaveLength(1)
  })

  it('sends nothing again when a snapshot holds nothing new', async () => {
    const { cursor, recording } = await golden('tool')
    const again = reconcile(cursor, recording.final).events
    expect(again.filter(({ type }) => type !== EventType.STATE_DELTA)).toEqual([])
  })

  it('opens an epoch with a window of the newest entries, hiding what a later entry omits', () => {
    const { chat, final } = fixture('tool')
    const [snapshot] = ofType(open(chat, final, { window: 2 }).events, EventType.MESSAGES_SNAPSHOT)
    expect(snapshot?.messages.map(({ role }) => role)).toEqual(['tool', 'assistant'])
    // A turn moved to a thread: the head left in its place omits the turn's entries (hand-made from the recording).
    const moved = {
      id: 99,
      conversationId: 1,
      kind: 'app.thread_head',
      data: { thread: '7', text: 'weather in Tallinn?', operationId: 'op-move', moved: true },
      model: [{ role: 'user', content: 'weather in Tallinn?', timestamp: 1760000000999 }],
      edits: [{ target: 7, action: 'omit' }],
    }
    const withMove: typeof final = JSON.parse(JSON.stringify({ ...final, entries: [...final.entries, moved] }))
    const [after] = ofType(open(chat, withMove, { window: 50 }).events, EventType.MESSAGES_SNAPSHOT)
    expect(after?.messages.map(({ id }) => id)).not.toContain('1:e7')
    expect(after?.messages.at(-1)).toMatchObject({ id: '1:e99', role: 'activity', activityType: 'goblin.thread_head' })
    const [answers] = ofType(forTier(open(chat, final, { window: 50 }).events, 'answers'), EventType.MESSAGES_SNAPSHOT)
    expect(answers?.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'assistant'])
    expect(answers?.messages.some((message) => message.role === 'assistant' && message.toolCalls !== undefined)).toBe(
      false,
    )
  })
})

describe('coalescing', () => {
  it('merges consecutive deltas of one message and keeps every other event as it is', () => {
    const { events } = replay(startCursor('1'), fixture('reasoning').batches)
    const merged = coalesce(events)
    expect(merged.length).toBeLessThan(events.length)
    for (const id of new Set(assistantIds(events))) {
      expect(textOf(merged, id)).toBe(textOf(events, id))
      expect(textOf(merged, `${id}:r0`)).toBe(textOf(events, `${id}:r0`))
    }
    expect(merged.filter(({ type }) => !type.endsWith('_CONTENT'))).toEqual(
      events.filter(({ type }) => !type.endsWith('_CONTENT')),
    )
    checked(merged)
  })
})
