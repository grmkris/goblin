// The AG-UI translator against the installed Pi, live: every scenario recorded now (not the committed fixtures) gives
// valid, well-formed streams in both tiers, and an epoch opened on the idle conversation is too. Timing decides how
// Pi batches its commits here, so this checks properties; the goldens (`agui.test.ts`) pin exact output.
import { EventType } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { open, startCursor } from '../../src/streams/agui.ts'
import { forTier } from '../../src/streams/tiers.ts'
import { checked, forkChild, replay, replayFamily, textOf } from './agui-check.ts'
import { type ScenarioName, record, scenarios } from './scenarios.ts'

// SAFETY: `scenarios` is a literal object, so its keys are exactly its scenario names.
const names = Object.keys(scenarios) as ScenarioName[]

describe('the translator on the installed Pi', () => {
  it.each(names)('%s: valid and well formed in both tiers, from the start and from a snapshot', async (name) => {
    const recording = await record(name)
    const { child } = recording
    const { events } =
      child === undefined
        ? replay(startCursor(recording.chat), recording.batches)
        : replayFamily(startCursor(recording.chat), recording, forkChild(child.chat))
    checked(events)
    checked(forTier(events, 'answers'), 'answers')
    const opened = open(recording.chat, recording.final, { window: 50 }).events
    checked(opened)
    checked(forTier(opened, 'answers'), 'answers')
    // Whatever the batching, an answer's streamed text is its committed text.
    const [snapshot] = opened.filter((event) => event.type === EventType.MESSAGES_SNAPSHOT)
    for (const message of snapshot?.type === EventType.MESSAGES_SNAPSHOT ? snapshot.messages : [])
      if (message.role === 'assistant' && message.name === undefined)
        expect(textOf(events, message.id)).toBe(message.content ?? '')
  })
})
