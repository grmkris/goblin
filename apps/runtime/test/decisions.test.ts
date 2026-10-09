import { describe, expect, it } from 'vitest'
import * as Effect from 'effect/Effect'
import type { DecisionProposal } from '@goblin/contracts'
import { ModelBudget } from '../src/budget.ts'
import { creditRates, milliCredits } from '../src/budget-credits.ts'
import { BudgetExhausted, ResidentInactive } from '../src/http/errors.ts'
import { DecisionService, type Judgment } from '../src/decisions/service.ts'
import { ClefError, workersClef } from '../src/decisions/client.ts'
import type { DecisionFence, ProposalStore, StoredDecision } from '../src/decisions/store.ts'
import { decodeAnswers } from '../src/decisions/wire.ts'
import type { AuxCall } from '../src/telemetry/report.ts'

class Kept implements ProposalStore {
  readonly proposals = new Map<string, StoredDecision>()
  get(id: string) {
    return this.proposals.get(id)
  }
  list() {
    return [...this.proposals.values()].map(({ proposal }) => proposal)
  }
  add(proposal: DecisionProposal, fence: DecisionFence) {
    this.proposals.set(proposal.id, { proposal, fence })
    return proposal
  }
  decide() {
    return undefined
  }
  stale() {
    return undefined
  }
}
const item = (text = 'The comparison has a useful new update.'): Judgment => ({
  id: 'dp_report_123',
  chatId: '1',
  subject: '123',
  ordinary: true,
  current: async () => true,
  fence: { session: '1', epoch: 0 },
  case: {
    id: 'report',
    task: 'attention-triage',
    state: { focus: 'Trip', result: text, runtimeKind: 'delegate-result' },
  },
  payload: { type: 'highlight', relayId: '123', text },
})
const answer = {
  answers: { 'report.attention': { probabilities: { '0': 0.05, '1': 0.05, '2': 0.05, '3': 0.85 } } },
  usage: { input_tokens: 1000, output_tokens: 0 },
}
function fixture(mode: 'ok' | 'budget' | 'resident' | 'unavailable' | 'malformed' | 'missing-usage' = 'ok') {
  const store = new Kept()
  const reported: AuxCall[] = []
  const recorded: number[] = []
  let calls = 0
  const service = new DecisionService({
    store,
    report: (call) => reported.push(call),
    resident: {
      require: () => {
        if (mode === 'resident') throw new ResidentInactive({ state: 'revoked' })
      },
    },
    budget: {
      require: async () => {
        if (mode === 'budget') throw new BudgetExhausted({ limit: 0, resetsAt: 0 })
      },
      record: (use, _now, model) => {
        expect(model).toBe('clef')
        recorded.push(use.input)
      },
    },
    client: {
      evaluate: () => {
        calls += 1
        return mode === 'unavailable'
          ? Effect.fail(new ClefError({ reason: 'unavailable' }))
          : Effect.succeed(
              mode === 'malformed'
                ? { usage: answer.usage }
                : mode === 'missing-usage'
                  ? { answers: answer.answers }
                  : answer,
            )
      },
    },
  })
  return { service, store, recorded, reported, calls: () => calls }
}

describe('typed decision critic', () => {
  it('applies deterministic rules without a provider call and never ranks runtime facts', async () => {
    const f = fixture()
    const proposal = await Effect.runPromise(f.service.consider(item('The flight is cancelled tonight.')))
    expect(proposal?.provider).toBe('rules')
    expect(f.calls()).toBe(0)
    expect(
      await Effect.runPromise(f.service.consider({ ...item(), id: 'dp_runtime', ordinary: false })),
    ).toBeUndefined()
    expect(f.calls()).toBe(0)
  })
  it('calls Clef only for undecided cases, meters usage, then persists once', async () => {
    const f = fixture()
    const first = await Effect.runPromise(f.service.consider(item()))
    expect(first).toMatchObject({ provider: 'cloudflare/clef', probability: 0.85, state: 'open' })
    expect(await Effect.runPromise(f.service.consider(item()))).toBeUndefined()
    expect(f.calls()).toBe(1)
    expect(f.recorded).toEqual([1000])
    expect(f.reported[0]?.message?.model).toBe('cloudflare/clef')
    expect(JSON.stringify(f.reported)).not.toContain('useful new update')
  })
  it.each(['budget', 'resident'] as const)('does not call when %s prevents dispatch', async (mode) => {
    const f = fixture(mode)
    expect(await Effect.runPromise(f.service.consider(item()))).toBeUndefined()
    expect(f.calls()).toBe(0)
    expect(f.recorded).toEqual([])
  })
  it('discards a stale result and retains its charged usage', async () => {
    const f = fixture()
    expect(await Effect.runPromise(f.service.consider({ ...item(), current: async () => false }))).toBeUndefined()
    expect(f.store.list()).toEqual([])
    expect(f.recorded).toEqual([1000])
  })
  it('unavailability leaves callers successful and does not invent usage for a missing binding', async () => {
    const f = fixture('unavailable')
    expect(await Effect.runPromise(f.service.consider(item()))).toBeUndefined()
    expect(f.store.list()).toEqual([])
    expect(f.recorded).toEqual([])
  })
  it('charges malformed and unknown-usage responses, and does not emit malformed proposals', async () => {
    const bad = fixture('malformed')
    expect(await Effect.runPromise(bad.service.consider(item()))).toBeUndefined()
    expect(bad.recorded).toEqual([1000])
    const unknown = fixture('missing-usage')
    expect(await Effect.runPromise(unknown.service.consider(item()))).toBeDefined()
    expect(unknown.recorded).toEqual([65_536])
  })
  it('allows uncertain and quiet to decline a proposal and rejects incomplete distributions', async () => {
    const f = fixture()
    expect(await Effect.runPromise(f.service.consider(item('Routine typo cleanup.')))).toBeUndefined()
    const question = {
      attention: { type: 'choice' as const, options: ['quiet', 'highlight'], instructions: '', criteria: {} },
    }
    expect(() => decodeAnswers({ answers: { attention: { quiet: 0.2 } } }, question)).toThrow()
    expect(() => decodeAnswers({ answers: { attention: { quiet: 0.8, highlight: 0.8 } } }, question)).toThrow()
  })
  it('uses the native binding wire and an explicit missing-binding error', async () => {
    let seen = ''
    const client = workersClef({
      run: async (model, input) => {
        seen = JSON.stringify({ model, input })
        return answer
      },
    })
    await Effect.runPromise(
      client.evaluate({
        state: 'evidence',
        questions: { yes: { type: 'noul', instructions: 'Judge', options: ['yes', 'no'], criteria: {} } },
      }),
    )
    expect(seen).toContain('@cf/cloudflare/clef')
    expect(seen).not.toContain('options')
    expect(
      await Effect.runPromise(Effect.result(workersClef(undefined).evaluate({ state: '', questions: {} }))),
    ).toMatchObject({ failure: { reason: 'unavailable' } })
  })
  it('retains the input-only Clef estimate through unrelated overrides', async () => {
    const use = { input: 5000, output: 9000, cacheRead: 0, cacheWrite: 0 }
    expect(milliCredits(use, 'clef', creditRates('{"models":{}}'))).toBe(1000)
    expect(
      milliCredits(
        use,
        'cloudflare/clef',
        creditRates('{"models":{"clef":{"input":10000,"cached":10000,"output":null}}}'),
      ),
    ).toBe(500)
    const budget = new ModelBudget({ milliCredits: () => 0, add: () => undefined }, 1)
    await budget.require(0)
  })
})
