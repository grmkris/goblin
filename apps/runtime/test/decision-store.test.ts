import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionProposal } from '@goblin/contracts'
import { DecisionStore } from '../src/decisions/store.ts'
import { appDecisionLabels } from '../src/storage/decision-schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const FENCE = { session: '1', epoch: 0 }
const proposal = (id: string, createdAt: number): DecisionProposal => ({
  id,
  chatId: '1',
  kind: 'attention-triage',
  subject: id,
  payload: { type: 'highlight', relayId: id, text: 'Done.' },
  state: 'open',
  probability: 0.6,
  provider: 'rules',
  createdAt,
})
function store() {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  return { db, store: new DecisionStore(db) }
}

describe('decision proposals in SQLite', () => {
  it('lists the newest 100 open and confirmed proposals, oldest first', () => {
    const { store: kept } = store()
    for (let at = 1; at <= 105; at += 1) kept.add(proposal(`dp_report_${at}`, at), FENCE)
    kept.decide('dp_report_105', 'dismiss', 200)
    kept.decide('dp_report_104', 'confirm', 200)
    const listed = kept.list()
    expect(listed).toHaveLength(100)
    expect(listed[0]?.id).toBe('dp_report_5')
    expect(listed.at(-1)).toMatchObject({ id: 'dp_report_104', state: 'confirmed', decidedAt: 200 })
  })

  it('keeps the first label, emits each change once, and leaves a settled proposal settled', () => {
    const { db, store: kept } = store()
    const seen: string[] = []
    kept.onChange((changed) => seen.push(`${changed.id}:${changed.state}`))
    kept.add(proposal('dp_report_1', 1), FENCE)
    kept.add(proposal('dp_report_1', 1), FENCE)
    expect(kept.decide('dp_report_1', 'confirm', 5)?.state).toBe('confirmed')
    expect(kept.decide('dp_report_1', 'dismiss', 6)?.state).toBe('confirmed')
    expect(kept.stale('dp_report_1', 7)?.state).toBe('confirmed')
    expect(db.select().from(appDecisionLabels).all()).toEqual([
      {
        proposalId: 'dp_report_1',
        label: 'confirm',
        judgedAt: 5,
        kind: 'attention-triage',
        provider: 'rules',
        probability: 0.6,
      },
    ])
    expect(seen).toEqual(['dp_report_1:open', 'dp_report_1:confirmed'])
    expect(kept.get('dp_report_1')?.fence).toEqual(FENCE)
  })
})
