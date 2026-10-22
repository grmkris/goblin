import type { InspectDetails, TurnStep } from '@goblin/contracts/inspect'
import { describe, expect, it } from 'vitest'
import { detailsView } from '../src/lib/details.ts'
import { durationText } from '../src/lib/format.ts'

const release = '393c8952c962d36fa35db51e8f710d4cd73edd3f'
const next = '5d6e7f8a9b0c1d2e3f405162738495a6b7c8d9e0'

const turn: NonNullable<InspectDetails['turn']> = {
  operationId: 'op-1',
  conversationId: '7',
  source: 'direct',
  status: 'ok',
  startedAt: 1_000,
  endedAt: 5_000,
  modelAttempts: 2,
  failedAttempts: 0,
  toolCalls: 1,
  failedToolCalls: 1,
  inputTokens: 28_000,
  outputTokens: 131,
  version: release,
}

const step = (fields: Partial<TurnStep> & Pick<TurnStep, 'kind'>): TurnStep => ({
  status: 'ok',
  offsetMs: 0,
  ms: 100,
  version: release,
  ...fields,
})

/** A turn that thought, called mycut and failed there, then thought again after its tools changed and a restart. */
const DETAILS: InspectDetails = {
  turn,
  events: [],
  steps: [
    step({ kind: 'model.attempt', offsetMs: 0, ms: 2_000, model: 'deepseek-v4.1-flash', attempt: 1 }),
    step({
      kind: 'tool.call',
      status: 'error',
      offsetMs: 2_000,
      ms: 400,
      tool: 'mcp_call',
      server: 'mycut',
      serverTool: 'job_submit',
      error: 'Remote MCP request failed (timeout).',
    }),
    step({
      kind: 'model.attempt',
      offsetMs: 2_400,
      ms: 1_600,
      model: 'deepseek-v4.1-flash',
      toolsAdded: 2,
      version: next,
    }),
  ],
  spent: { totalMs: 4_000, modelMs: 3_600, toolMs: 400, servers: [], otherMs: 0 },
  ranWith: { versions: [release, next], endpoints: ['deployment'], thinking: ['low'], promptChanges: 1, servers: [] },
  coverage: { complete: false, gaps: ['The agent restarted during this turn.', 'Some events have not ended.'] },
  related: [
    { operation: 'op-2', kind: 'start', chat: '9', state: 'ok' },
    { operation: 'op-3', kind: 'thread_announce' },
  ],
}

/** The note on a lone model attempt with `fields`. */
const changed = (fields: Partial<TurnStep>) =>
  detailsView({ ...DETAILS, steps: [step({ kind: 'model.attempt', ...fields })] }, 9_000).steps[0]?.note

describe("a message's Details, in the owner's words", () => {
  it('says how the turn ended in a sentence around its time', () => {
    expect(detailsView(DETAILS, 9_000).outcome).toEqual({ before: 'Answered in', ms: 4_000 })
    const failed = { ...DETAILS, turn: { ...turn, status: 'error' as const, reason: 'model_error' } }
    expect(detailsView(failed, 9_000).outcome).toEqual({
      before: 'Failed after',
      ms: 4_000,
      after: ': the model did not answer',
    })
    const { endedAt: _, ...open } = turn
    expect(detailsView({ ...DETAILS, turn: { ...open, status: 'started' } }, 9_000).outcome).toEqual({
      before: 'Still working,',
      ms: 8_000,
      running: true,
      after: ' so far',
    })
    expect(detailsView({ ...DETAILS, turn: undefined }, 9_000)).toMatchObject({
      outcome: { before: 'Nothing ran for this message; it was written directly.' },
    })
  })

  it("reads each step like the chat's tool rows, with why it failed and what changed under it", () => {
    const [thought, used, again] = detailsView(DETAILS, 9_000).steps
    expect(thought).toMatchObject({ state: 'done', lead: 'Thought', model: 'deepseek-v4.1-flash', ms: 2_000 })
    expect(thought?.note).toBeUndefined()
    expect(used).toMatchObject({
      state: 'error',
      lead: 'Used',
      server: 'mycut',
      tool: 'job_submit',
      problem: 'Remote MCP request failed (timeout).',
    })
    // A restart into another release is the note that matters most; the tools that changed with it are in the footer's count.
    expect(again?.note).toBe('goblin restarted into build 5d6e7f8 before this.')
  })

  it("places steps on the turn's timeline once there are two to compare", () => {
    const [thought, used] = detailsView(DETAILS, 9_000).steps
    expect(thought?.bar).toEqual({ left: 0, width: 50 })
    expect(used?.bar).toEqual({ left: 50, width: 10 })
    const one = detailsView({ ...DETAILS, steps: DETAILS.steps?.slice(0, 1) }, 9_000).steps
    expect(one[0]?.bar).toBeUndefined()
  })

  it('names what changed before a step: tools by count, else its instructions, never a restatement', () => {
    expect(changed({ toolsAdded: 1, toolsRemoved: 2 })).toBe('1 tool added, 2 removed before this.')
    expect(changed({ promptSections: ['persona'] })).toBe('Its instructions changed before this.')
    expect(changed({ promptSections: ['persona'], toolsAdded: 12, promptBaseline: true })).toBeUndefined()
  })

  it('says where it led, what was not recorded, and what it ran with', () => {
    const view = detailsView(DETAILS, 9_000)
    expect(view.related).toEqual([
      { operation: 'op-2', label: 'Started a thread', chat: '9' },
      { operation: 'op-3', label: 'Related' },
    ])
    expect(view.gaps).toBe('The agent restarted during this turn. Some events have not ended.')
    expect(view.footer).toBe('28.1K tokens on goblin’s model, thinking low, build 393c895.')
    expect(detailsView({ ...DETAILS, turn: undefined }, 9_000).footer).toBeUndefined()
  })

  it('reads durations plainly for a screen reader', () => {
    expect(durationText(250)).toBe('250 ms')
    expect(durationText(90_000)).toBe('1.5 min')
  })
})
