import type { InspectDetails } from '@goblin/contracts/inspect'
import { describe, expect, it } from 'vitest'
import { detailSteps, detailSummary, ranWithText, relatedText } from '../src/lib/details.ts'
import { durationText } from '../src/lib/format.ts'

const DETAILS: InspectDetails = {
  turn: {
    operationId: 'op-1',
    conversationId: '7',
    source: 'app',
    status: 'error',
    reason: 'tool_failed',
    startedAt: 1_000,
    endedAt: 5_200,
    modelAttempts: 2,
    failedAttempts: 1,
    toolCalls: 1,
    failedToolCalls: 1,
    inputTokens: 1200,
    outputTokens: 80,
    errors: 1,
  },
  events: [
    {
      id: 'e3',
      kind: 'tool.call',
      status: 'error',
      startedAt: 3_000,
      endedAt: 3_400,
      attributes: { 'gen_ai.tool.name': 'mcp_call', 'error.type': 'UpstreamMcp' },
    },
    {
      id: 'e2',
      kind: 'model.attempt',
      status: 'ok',
      startedAt: 1_100,
      endedAt: 2_900,
      attributes: {
        'gen_ai.response.model': 'sonnet',
        'gen_ai.usage.input_tokens': 600,
        'gen_ai.usage.output_tokens': 40,
      },
    },
    {
      id: 'e4',
      kind: 'flow',
      status: 'ok',
      startedAt: 5_000,
      attributes: { 'goblin.flow': 'reply', 'goblin.flow.via': 'app' },
    },
  ],
  coverage: { complete: true, gaps: [] },
  related: [{ operation: 'op-2', kind: 'start', chat: '9', state: 'settled' }],
}

describe("a message's details, in the owner's words", () => {
  it('lists the steps in the order they ran, each with what it touched and how it ended', () => {
    expect(detailSteps(DETAILS)).toEqual([
      { id: 'e2', label: 'Model sonnet', detail: '600 in · 40 out tokens', status: 'ok', ms: 1800 },
      { id: 'e3', label: 'Tool mcp_call', detail: 'UpstreamMcp', status: 'error', ms: 400 },
      { id: 'e4', label: 'Flow reply', detail: 'app', status: 'ok', ms: undefined },
    ])
  })
  it('sums the operation up, and says when no model ran for it', () => {
    expect(detailSummary(DETAILS)).toEqual([
      'From app · error (tool_failed) · 4.2 s',
      '2 model attempts (1 failed) · 1 tool call (1 failed)',
      '1200 in · 80 out tokens · 1 error',
    ])
    expect(detailSummary({ ...DETAILS, turn: undefined })).toEqual(['A written note: no model ran for it.'])
  })
  it("places each step on the turn's timeline when the turn's wall time is known", () => {
    const spent = { totalMs: 4_200, modelMs: 1_800, toolMs: 400, servers: [], otherMs: 2_000 }
    const [attempt, tool, flow] = detailSteps({ ...DETAILS, spent }, 6_000)
    expect(attempt).toMatchObject({ offsetMs: 100, bar: { left: (100 / 4_200) * 100, width: (1_800 / 4_200) * 100 } })
    expect(tool?.bar?.left).toBeCloseTo((2_000 / 4_200) * 100)
    // A step with no end runs to now, never past the end of the timeline; an instant still shows.
    expect(flow?.bar).toEqual({ left: (4_000 / 4_200) * 100, width: 100 - (4_000 / 4_200) * 100 })
    expect(detailSteps(DETAILS)[0]?.bar).toBeUndefined()
  })
  it('says what the turn ran with, and what changed under it (ADR 0107)', () => {
    const ranWith = {
      versions: ['3f8f88b1c0ffee', '5d6e7f8a9b0c1d'],
      endpoints: ['deployment' as const],
      thinking: ['medium'],
      promptChanges: 2,
      servers: [{ server: 'mycut', name: 'my_cut', version: '1.4.2' }],
    }
    expect(ranWithText(ranWith)).toBe(
      'Build 3f8f88b · restarted into 5d6e7f8 · goblin’s model endpoint · thinking medium · prompt or tools changed before 2 attempts · my_cut 1.4.2',
    )
    expect(detailSummary({ ...DETAILS, ranWith }).at(-1)).toBe(`Ran with ${ranWithText(ranWith)}`)
    const changed = detailSteps({
      ...DETAILS,
      events: [
        {
          id: 'e5',
          kind: 'model.attempt',
          status: 'ok',
          startedAt: 1_100,
          endedAt: 2_000,
          attributes: { 'goblin.tools.added': 1, 'goblin.tools.changed': 'mycut__job_submit' },
        },
      ],
    })
    expect(changed[0]?.detail).toBe('prompt or tools changed before it')
  })
  it('reads related operations and durations plainly', () => {
    expect(relatedText({ operation: 'op-2', kind: 'start', state: 'settled' })).toBe('start · settled')
    expect(durationText(250)).toBe('250 ms')
    expect(durationText(90_000)).toBe('1.5 min')
  })
})
