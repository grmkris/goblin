import { Effect, Schema } from 'effect'
import { expect } from 'vitest'
import { DecisionProposal } from '@goblin/contracts'
const Proof = Schema.Struct({
  once: Schema.Boolean,
  staleDiscarded: Schema.Boolean,
  noBudgetCall: Schema.Boolean,
  unavailableDiscarded: Schema.Boolean,
  ownerCandidate: Schema.Boolean,
  evidenceFence: Schema.Boolean,
  confirmed: DecisionProposal,
  replay: DecisionProposal,
  dismissed: DecisionProposal,
  opposite: Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) }),
  charged: Schema.Number,
  retained: Schema.Array(DecisionProposal),
  chatAnswer: Schema.String,
  labels: Schema.Array(Schema.Struct({ proposalId: Schema.String, label: Schema.String, probability: Schema.Number })),
})
export const decisionsCase = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/decisions-probe?name=decisions-${Date.now()}`, {
        headers: { connection: 'close' },
      }),
    )
    expect(response.status).toBe(200)
    const result = yield* Schema.decodeUnknownEffect(Proof)(yield* Effect.promise(() => response.json()))
    expect(result.once).toBe(true)
    expect(result.confirmed.state).toBe('confirmed')
    expect(result.replay).toEqual(result.confirmed)
    expect(result.dismissed.state).toBe('dismissed')
    expect(result.opposite.error._tag).toBe('Conflict')
    expect(result.labels.map((label) => label.label).toSorted()).toEqual(['confirm', 'dismiss'])
    expect(result.labels.every((label) => label.probability === 0.85)).toBe(true)
    expect(result.retained.map((proposal) => proposal.id)).toEqual([result.confirmed.id])
    expect(result.staleDiscarded).toBe(true)
    expect(result.noBudgetCall).toBe(true)
    expect(result.unavailableDiscarded).toBe(true)
    expect(result.ownerCandidate).toBe(true)
    expect(result.evidenceFence).toBe(true)
    expect(result.charged).toBe(3000)
    expect(result.chatAnswer.length).toBeGreaterThan(0)
  })
