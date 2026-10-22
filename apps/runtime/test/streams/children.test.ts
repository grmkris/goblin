// A chat's children in its stream (docs/architecture/streams.md): a Persona's fork recorded on a real Pi Harness
// (`scenarios.ts`, `fork`), its work carried in its parent's stream under its `subagentRunId` between SUBAGENT_STARTED
// and its end, kept as a golden beside the others; what the answers tier keeps of it; a late joiner's opening; and a
// subagent's runs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AguiEvent, EventType } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { type StreamCursor, open, startCursor, translate } from '../../src/streams/agui.ts'
import { childBatch, childEnded, childStarted } from '../../src/streams/children.ts'
import { forTier } from '../../src/streams/tiers.ts'
import { checked, forkChild, replayFamily, textOf } from './agui-check.ts'
import type { Recording } from './scenarios.ts'

const recording: Recording = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/fork.json', import.meta.url).href), 'utf8'),
)
const kid = recording.child
if (kid === undefined) throw new Error('the fork fixture has no child')
const FORK = kid.chat
const child = forkChild(FORK)

/** The chats of the children whose work `cursor` carries now. */
const childrenOf = (cursor: StreamCursor): readonly string[] => Object.keys(cursor.children ?? {})

const ofType = <T extends EventType>(events: readonly AguiEvent[], type: T) =>
  events.filter((event): event is Extract<AguiEvent, { type: T }> => event.type === type)

/** The events attributed to the fork. */
const forks = (events: readonly AguiEvent[]) =>
  events.filter((event) => 'subagentRunId' in event && event.subagentRunId === FORK)

/** The fork's streamed answers, by message id, in the order they start. */
const forkAnswers = (events: readonly AguiEvent[]) =>
  ofType(forks(events), EventType.TEXT_MESSAGE_START).flatMap((event) =>
    event.role === 'assistant' ? [event.messageId] : [],
  )

/** The whole family translated, checked in both tiers, and kept as the `fork` golden. */
async function golden() {
  const { events, cursor } = replayFamily(startCursor(recording.chat), recording, child)
  const answers = forTier(checked(events), 'answers')
  const opened = open(recording.chat, recording.final, { window: 50 }).events
  const kept = { full: events, answers: checked(answers, 'answers'), open: checked(opened) }
  await expect(`${JSON.stringify(kept, null, 2)}\n`).toMatchFileSnapshot('__snapshots__/fork.agui.json')
  return { events, answers, cursor }
}

describe("a Persona's fork in its parent's stream", () => {
  it('carries its work under its subagentRunId, from SUBAGENT_STARTED to SUBAGENT_FINISHED after its answer', async () => {
    const { events, cursor } = await golden()
    const lifecycle = events.flatMap((event) =>
      event.type.startsWith('SUBAGENT_') || (event.type === EventType.TEXT_MESSAGE_START && !('subagentRunId' in event))
        ? [`${event.type}${'name' in event && event.name !== undefined ? ` ${event.name}` : ''}`]
        : [],
    )
    expect(lifecycle).toEqual([
      'TEXT_MESSAGE_START',
      'SUBAGENT_STARTED Squarewave',
      'TEXT_MESSAGE_START Squarewave',
      'SUBAGENT_FINISHED',
    ])
    const [started] = ofType(events, EventType.SUBAGENT_STARTED)
    expect(started).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: FORK,
      name: 'Squarewave',
      metadata: { goblin: { persona: child.persona, invocation: { state: 'running' } } },
    })
    // The fork's own answers stream under its id: its text, its thinking and its tool call, its prompt with them.
    const [checking, launch] = forkAnswers(events)
    expect(textOf(events, checking ?? '')).toBe('Checking the sky.')
    expect(textOf(events, launch ?? '')).toBe('Launch on Monday.')
    expect(textOf(events, `${launch}:r0`)).toBe('Sunny, so Monday.')
    expect(ofType(forks(events), EventType.STEP_STARTED).map(({ stepName }) => stepName)).toEqual(['turn 1', 'turn 2'])
    // Its answer arrives in the parent as the parent's own message, naming the fork; then its work ends.
    const answer = ofType(events, EventType.TEXT_MESSAGE_START).find((event) => event.name === 'Squarewave')
    expect(answer).not.toHaveProperty('subagentRunId')
    expect(answer?.metadata).toMatchObject({ goblin: { subagentRunId: FORK, persona: { operationId: 'op-fork' } } })
    const finished = ofType(events, EventType.SUBAGENT_FINISHED)
    expect(finished).toEqual([
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: FORK,
        outcome: { type: 'success' },
        metadata: {
          goblin: {
            entryId: Number(answer?.messageId.split(':e')[1]),
            persona: { ...child.persona },
            invocation: { state: 'answered' },
          },
        },
      },
    ])
    expect(events.at(-1)).toEqual(finished[0])
    expect(childrenOf(cursor)).toEqual([])
    // Nothing of the parent's run is the fork's: no run event carries its id, and the parent ran no run at all.
    expect(ofType(events, EventType.RUN_STARTED)).toEqual([])
    expect(forks(events).filter(({ type }) => type.startsWith('RUN_') || type.startsWith('STATE_'))).toEqual([])
  })

  it("keeps the fork's ids its own: its messages start with its chat, its tool calls too", async () => {
    const { events } = await golden()
    for (const event of forks(events)) {
      if ('messageId' in event) expect(event.messageId.startsWith(`${FORK}:`), event.messageId).toBe(true)
      if ('toolCallId' in event) expect(event.toolCallId.startsWith(`${FORK}:`), event.toolCallId).toBe(true)
    }
    const [call] = ofType(events, EventType.TOOL_CALL_START)
    expect(call).toMatchObject({ toolCallId: `${FORK}:call-1`, toolCallName: 'forecast', subagentRunId: FORK })
    const progress = ofType(events, EventType.CUSTOM).map(({ value }: { value: unknown }) => value)
    expect(progress).toContainEqual({ toolCallId: `${FORK}:call-1`, status: 'running' })
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([
      expect.objectContaining({
        messageId: `${FORK}:tcall-1`,
        toolCallId: `${FORK}:call-1`,
        content: 'Tallinn: sunny',
      }),
    ])
  })

  it('leaves the answers tier only its lifecycle and its answer', async () => {
    const { answers } = await golden()
    expect(answers.filter((event) => 'subagentRunId' in event && !event.type.startsWith('SUBAGENT_'))).toEqual([])
    expect(answers.map(({ type }) => type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.SUBAGENT_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.SUBAGENT_FINISHED,
    ])
    const [started] = ofType(answers, EventType.SUBAGENT_STARTED)
    expect(started?.metadata).toEqual({ goblin: { persona: child.persona, invocation: { state: 'running' } } })
    const [finished] = ofType(answers, EventType.SUBAGENT_FINISHED)
    expect(finished?.metadata).toMatchObject({
      goblin: { entryId: expect.any(Number), invocation: { state: 'answered' } },
    })
  })

  it('opens a late joiner with the fork in flight: SUBAGENT_STARTED and its run so far, then goes on', () => {
    const { mid } = recording
    if (mid === undefined || kid.mid === undefined) throw new Error('the fork fixture has no mid-answer snapshots')
    const opened = open(recording.chat, mid.snapshot, { window: 50 })
    const joined = childStarted(opened.cursor, child, { snapshot: kid.mid.snapshot })
    const forked = forks(joined.events)
    expect(joined.events[0]).toMatchObject({ type: EventType.SUBAGENT_STARTED, subagentRunId: FORK })
    // The run so far: its prompt, the answer that called the tool and its result, the step it is in, the answer in
    // flight with its thinking.
    const [checking, launch] = forkAnswers(forked)
    expect(textOf(forked, checking ?? '')).toBe('Checking the sky.')
    expect(textOf(forked, `${launch}:r0`)).toBe('Sunny, so Monday.')
    expect(ofType(forked, EventType.TOOL_CALL_RESULT)).toHaveLength(1)
    // A second start of a child carried already only catches it up: here, nothing new.
    expect(childStarted(joined.cursor, child, { snapshot: kid.mid.snapshot }).events).toEqual([])
    // The rest comes from the batches after the snapshots, in the order they came, nothing twice.
    const rest = goOn(joined.cursor, mid.after, kid.mid.after)
    const all = checked([...opened.events, ...joined.events, ...rest.events])
    expect(textOf(all, launch ?? '')).toBe('Launch on Monday.')
    expect(ofType(all, EventType.SUBAGENT_STARTED)).toHaveLength(1)
    expect(ofType(all, EventType.SUBAGENT_FINISHED)).toHaveLength(1)
    expect(forkAnswers(all)).toEqual([checking, launch])
  })

  it('carries what a fork did from its prompt on when its start is taken late, then ends it at its answer', () => {
    const prompt = kid.final.entries.find((entry) => entry.kind === 'pi.user' && String(entry.conversationId) === FORK)
    const late = childStarted(startCursor(recording.chat), child, {
      snapshot: kid.final,
      after: Number(prompt?.id) - 1,
    })
    const forked = forks(late.events)
    // Its whole work so far, as committed messages: no run of its own is in flight, so no step opens.
    expect(forked.filter(({ type }) => type.startsWith('STEP_'))).toEqual([])
    const [checking, launch] = forkAnswers(forked)
    expect(textOf(forked, checking ?? '')).toBe('Checking the sky.')
    expect(textOf(forked, launch ?? '')).toBe('Launch on Monday.')
    // The inherited history before its prompt is not its work.
    expect(ofType(forked, EventType.TEXT_MESSAGE_START).map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ])
    const answered = translate(late.cursor, recording.batches.at(-1) ?? [])
    expect(answered.events.at(-1)).toMatchObject({ type: EventType.SUBAGENT_FINISHED, subagentRunId: FORK })
    checked([...late.events, ...answered.events])
  })

  it('ends a fork whose answer waits for the owner as suspended, on what the answer raised', () => {
    const held: Recording = JSON.parse(
      readFileSync(fileURLToPath(new URL('fixtures/persona.json', import.meta.url).href), 'utf8'),
    )
    // The fixture's held answer (operation `op-persona-2`) names no fork: its Persona and operation find the child.
    const persona = {
      id: 4,
      name: 'Squarewave',
      revision: 2,
      avatar: { glyph: 'S', hue: 210 },
      operationId: 'op-persona-2',
    }
    const started = childStarted(startCursor(held.chat), { chat: '12', name: 'Squarewave', persona }, { after: 0 })
    let at = started.cursor
    const events: AguiEvent[] = [...started.events]
    for (const batch of held.batches) {
      const step = translate(at, batch)
      events.push(...step.events)
      at = step.cursor
    }
    checked(events)
    const [finished] = ofType(events, EventType.SUBAGENT_FINISHED)
    expect(finished).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: '12',
      outcome: { type: 'suspended', interruptIds: ['1:i11'] },
      metadata: {
        goblin: {
          entryId: 11,
          persona: {
            ...persona,
            hold: { kind: 'grant', connectionId: 'calendar', name: 'events_list', fork: '12' },
          },
          invocation: { state: 'answered' },
        },
      },
    })
    // The answer to the other operation ended nothing.
    expect(events.findIndex((event) => event === finished)).toBeGreaterThan(
      events.findIndex((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId === '1:e11'),
    )
    expect(childrenOf(at)).toEqual([])
  })

  it('ends a failed or stopped fork with SUBAGENT_ERROR, what it left open closed first', () => {
    const { mid } = recording
    if (mid === undefined || kid.mid === undefined) throw new Error('the fork fixture has no mid-answer snapshots')
    const joined = childStarted(startCursor(recording.chat), child, { snapshot: kid.mid.snapshot })
    const failed = childEnded(joined.cursor, FORK, {
      outcome: 'failed',
      code: 'model_error',
      message: 'Its model call failed.',
      reason: 'model_error',
    })
    expect(failed.events.at(-1)).toEqual({
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: FORK,
      code: 'model_error',
      message: 'Its model call failed.',
      metadata: { goblin: { persona: child.persona, invocation: { state: 'failed', reason: 'model_error' } } },
    })
    checked([...joined.events, ...failed.events])
    expect(childrenOf(failed.cursor)).toEqual([])
    const stopped = childEnded(joined.cursor, FORK, { outcome: 'stopped' }).events.at(-1)
    expect(stopped).toMatchObject({ code: 'stopped', metadata: { goblin: { invocation: { state: 'stopped' } } } })
    // A child the stream does not carry ends nothing.
    expect(childEnded(startCursor(recording.chat), FORK, { outcome: 'stopped' }).events).toEqual([])
  })
})

describe("a subagent's runs in its parent's stream", () => {
  it('starts it when its run begins and ends it when the run ends, with no Persona marks', () => {
    const helper = { chat: FORK, name: 'Researcher' }
    const { events, cursor } = replayFamily(startCursor(recording.chat), recording, helper, true)
    checked(events)
    checked(forTier(events, 'answers'), 'answers')
    const lifecycle = events.filter(({ type }) => type.startsWith('SUBAGENT_'))
    expect(lifecycle).toEqual([
      { type: EventType.SUBAGENT_STARTED, subagentRunId: FORK, name: 'Researcher' },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: FORK, outcome: { type: 'success' } },
    ])
    // Its run's own events are between them; the answer written into the parent comes after.
    const ended = events.findIndex(({ type }) => type === EventType.SUBAGENT_FINISHED)
    expect(forks(events.slice(ended + 1))).toEqual([])
    expect(childrenOf(cursor)).toEqual([])
  })
})

/** The parent's batches from `parentFrom` and the fork's from `childFrom`, in the order they came, from `cursor`. */
function goOn(cursor: StreamCursor, parentFrom: number, childFrom: number) {
  let at = cursor
  const events: AguiEvent[] = []
  const seen = { parent: 0, child: 0 }
  for (const who of kid?.order ?? []) {
    const index = seen[who]
    seen[who] += 1
    if (index < (who === 'parent' ? parentFrom : childFrom)) continue
    const step =
      who === 'parent'
        ? translate(at, recording.batches[index] ?? [])
        : childBatch(at, child, kid?.batches[index] ?? [], { runs: false, after: 0 })
    events.push(...step.events)
    at = step.cursor
  }
  return { events, cursor: at }
}
