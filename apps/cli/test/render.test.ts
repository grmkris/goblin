import { describe, expect, it } from 'vitest'
import { failureText, render } from '../src/render.ts'

const AT = Date.UTC(2026, 9, 6, 10, 0, 0)
const turn = {
  operationId: 'source-12',
  conversationId: '1',
  source: 'source',
  status: 'error',
  reason: 'model_error',
  startedAt: AT,
  endedAt: AT + 900,
  modelAttempts: 2,
  failedAttempts: 1,
  toolCalls: 1,
  failedToolCalls: 1,
  inputTokens: 120,
  outputTokens: 30,
  version: '3f8f88b1c0ffee',
}
const event = (kind: string, status: string, attributes: Record<string, string | number>) => ({
  id: `${kind}-${status}`,
  kind,
  status,
  operationId: 'source-12',
  startedAt: AT,
  endedAt: AT + 250,
  attributes,
})

describe('goblin output (unit)', () => {
  it('shows a turn as its summary, Pi settlement, events and gaps', () => {
    const text = render('turn', {
      turn,
      submission: { status: 'unanswered', reason: 'model_error' },
      events: [
        event('model.attempt', 'error', { 'gen_ai.request.model': 'gpt-test', 'goblin.error': 'rate limited' }),
        event('tool.call', 'blocked', { 'gen_ai.tool.name': 'mcp_call', 'goblin.blocked_reason': 'grant' }),
      ],
      steps: [],
      spent: {
        totalMs: 61_000,
        modelMs: 250,
        toolMs: 30_250,
        servers: [{ server: 'mycut', calls: 1, ms: 30_000 }],
        otherMs: 30_500,
      },
      ranWith: {
        versions: ['3f8f88b1c0ffee', '5d6e7f8a9b0c1d'],
        endpoints: ['deployment'],
        thinking: ['medium'],
        promptChanges: 1,
        servers: [{ server: 'mycut', name: 'my_cut', version: '1.4.2' }],
      },
      coverage: { complete: false, gaps: ['Some events have not ended.'] },
    })
    expect(text.split('\n')).toEqual([
      '2026-10-06 10:00:00  error        source           2 calls (1 failed)  1 tools (1 failed)  120/30 tok  source-12  @3f8f88b  model_error',
      'Pi: unanswered (model_error)',
      'Time: 61.0s, model 0.3s, tools 30.3s (mycut 30.0s ×1), other 30.5s',
      'Ran with: 3f8f88b → 5d6e7f8, deployment endpoint, thinking medium, prompt or tools changed before 1 attempt, mycut (my_cut) 1.4.2',
      '',
      '2026-10-06 10:00:00  model.attempt    error          250ms  gpt-test  rate limited',
      expect.stringMatching(/^2026-10-06 10:00:00 {2}tool\.call {8}blocked {8}250ms {2}mcp_call/u),
      '',
      '! Some events have not ended.',
    ])
  })

  it("shows a conversation's entries with an answer's thinking before its words", () => {
    const text = render('conversation', {
      conversation: '1',
      entries: [
        {
          id: 9,
          kind: 'pi.assistant',
          role: 'assistant',
          thinking: 'Plan the app.\nThen build it.',
          text: 'Done.',
          model: {
            provider: 'goblin-litellm',
            model: 'glm-5.3',
            stopReason: 'length',
            inputTokens: 10,
            outputTokens: 32_768,
            cacheReadTokens: 0,
          },
        },
      ],
    })
    expect(text.split('\n')).toEqual([
      '#9 assistant',
      '  ~ Plan the app.',
      '  ~ Then build it.',
      '  Done.',
      '  [glm-5.3 length]',
    ])
  })

  it("says a tool's failure in a line", () => {
    expect(failureText('{"_tag":"NotFound","what":"turn"}')).toBe('NotFound: what=turn')
    expect(failureText('plain words')).toBe('plain words')
  })

  it('falls back to JSON for shapes it does not know', () => {
    expect(render('turns', { unexpected: true })).toBe('{\n  "unexpected": true\n}')
    expect(render('turns', { turns: [] })).toBe('No turns in that window.')
  })

  it("renders flow steps and a message's details with what they relate to", () => {
    const step = { flow: 'move', via: 'app', actor: 'owner', chat: '12', operationId: 'owner:op-9', status: 'refused' }
    expect(render('flows', { since: 0, flows: [{ ...step, ms: 40, at: AT }] })).toBe(
      '2026-10-06 10:00:00  move                 refused   app/owner         chat 12  owner:op-9  40ms',
    )
    expect(render('flows', { since: 0, flows: [] })).toBe('No flows in that window.')
    const details = render('details', {
      events: [event('flow', 'blocked', {})],
      coverage: { complete: true, gaps: [] },
      related: [{ operation: 'owner:op-8', kind: 'send', chat: '1', state: 'ok' }],
    })
    expect(details.split('\n')).toEqual([
      'No turn: the steps of this operation',
      '',
      `2026-10-06 10:00:00  flow             blocked        250ms    source-12`,
      '',
      'Related:',
      '  send  owner:op-8  chat 1  ok',
    ])
    expect(
      render('details', {
        turn: { ...turn, errors: 2 },
        events: [],
        coverage: { complete: true, gaps: [] },
        related: [],
      }),
    ).toContain('2 errors')
  })
})
