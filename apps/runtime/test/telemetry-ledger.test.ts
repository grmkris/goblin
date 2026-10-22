import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { afterEach, describe, expect, it } from 'vitest'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { appRunEvents } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  return { db, ledger: new RunLedger(db) }
}

const turn: RunEvent = {
  id: 'turn:op-1',
  kind: 'turn.submitted',
  status: 'error',
  conversationId: '41',
  operationId: 'op-1',
  startedAt: 100,
  endedAt: 120,
  attributes: { [RunAttribute.errorType]: 'Internal' },
}

describe('run ledger reads', () => {
  it("never keeps the deployment endpoint's host, so no inspection answers it (ADR 0107)", () => {
    const { ledger } = fixture()
    const attempt: RunEvent = {
      id: 'model:t1:1:9',
      kind: 'model.attempt',
      status: 'ok',
      operationId: 'op-1',
      taskId: 't1',
      startedAt: 100,
      endedAt: 120,
      attributes: {
        [RunAttribute.modelEndpoint]: 'deployment',
        [RunAttribute.serverAddress]: 'gateway.example.com',
        [RunAttribute.serverPort]: 443,
      },
    }
    ledger.ended(attempt)
    expect(ledger.read(attempt.id)?.attributes).toEqual({ [RunAttribute.modelEndpoint]: 'deployment' })
  })

  it('skips and counts a row whose kind this build does not know, and reads the rest', () => {
    const { db, ledger } = fixture()
    ledger.ended(turn)
    // A newer build wrote this row: its kind is unknown here, which must not fail any read.
    db.insert(appRunEvents)
      .values({
        id: 'future:op-1',
        kind: 'from-a-newer-build',
        status: 'error',
        conversationId: '41',
        operationId: 'op-1',
        taskId: null,
        startedAt: 110,
        endedAt: 111,
        attributes: '{}',
      })
      .run()

    expect(ledger.forOperation('op-1')).toEqual([turn])
    expect(ledger.forOperations(['op-1'])).toEqual([turn])
    expect(ledger.read('future:op-1')).toBeUndefined()
    expect(ledger.read(turn.id)).toEqual(turn)
    expect(ledger.problems(0, 10)).toEqual([turn])
    expect(ledger.turns(0, 10)).toEqual([turn])
    expect(ledger.skipped).toBe(4)
  })

  it('finds the operations that start with a prefix, as long as a server key makes them and holding _ and %', () => {
    const { ledger } = fixture()
    const job = 'swarmm:dev:job:job_8df3bec61affd7618a69675ca5231978:1:first'
    for (const operationId of [
      `persona:${job}:16`,
      `persona:${job}:17`,
      `persona:${job}x:16`,
      'persona:swarmm:dev:job:job%8df3:1:first:16',
      job,
    ])
      ledger.ended({ ...turn, id: `turn:${operationId}`, operationId })
    expect(ledger.operationsStarting(`persona:${job}:`).toSorted()).toEqual([`persona:${job}:16`, `persona:${job}:17`])
    expect(ledger.operationsStarting(job)).toEqual([job])
    expect(ledger.operationsStarting('persona:swarmm:dev:job:job_')).toHaveLength(3)
  })

  it('keeps paging problems past a full page of unknown rows', () => {
    const { db, ledger } = fixture()
    ledger.ended({ ...turn, startedAt: 1 })
    db.insert(appRunEvents)
      .values(
        Array.from({ length: 70 }, (_, index) => ({
          id: `future:${index}`,
          kind: 'from-a-newer-build',
          status: 'error' as const,
          conversationId: null,
          operationId: null,
          taskId: null,
          startedAt: 10 + index,
          endedAt: null,
          attributes: '{}',
        })),
      )
      .run()

    expect(ledger.problems(0, 5)).toEqual([{ ...turn, startedAt: 1 }])
    expect(ledger.skipped).toBe(70)
  })
})
