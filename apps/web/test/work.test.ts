import { describe, expect, it } from 'vitest'
import { type ConversationView, PersonaInvocationView } from '@goblin/contracts'
import { Schema } from 'effect'
import { railCounts } from '../src/lib/rail.ts'
import { workLists } from '../src/lib/work.ts'
import type { Activity } from '../src/lib/workspace/slices.ts'

const subagent = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'subagent',
  parent: '1',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...extra,
})
const VIEWS = [
  subagent('4'),
  subagent('5', { lastReplyAt: 60 }),
  subagent('6', { lastReplyAt: 70 }),
  subagent('7', { closedAt: 80, closedBy: 'done' }),
]
const ACTIVITY: Activity = {
  '4': { id: '4', state: 'working', since: 1 },
  '6': { id: '6', state: 'waiting', since: 2 },
}
const invocation = (persona: number, state: PersonaInvocationView['state'], createdAt: number) =>
  Schema.decodeUnknownSync(PersonaInvocationView)({
    operationId: `op-${String(persona)}`,
    persona,
    revision: 1,
    chat: '1',
    order: persona,
    state,
    createdAt,
  })
const INVOCATIONS = [invocation(1, 'answered', 5), invocation(2, 'running', 9), invocation(3, 'failed', 7)]
const ids = (views: readonly ConversationView[]) => views.map(({ id }) => id)

describe('Work', () => {
  it('runs the Delegates at work or waiting on their own, and the Persona answers on their way', () => {
    const { running } = workLists(VIEWS, ACTIVITY, INVOCATIONS)
    expect(ids(running.delegates)).toEqual(['6', '4'])
    expect(running.answers.map(({ persona }) => persona)).toEqual([2])
  })

  it('counts in Running exactly what its rail count counts, never more', () => {
    const { running } = workLists(VIEWS, ACTIVITY, INVOCATIONS)
    const counts = railCounts({
      views: VIEWS,
      apps: [],
      activity: ACTIVITY,
      invocations: INVOCATIONS,
      notifications: [],
    })
    expect(running.delegates.length + running.answers.length).toBe(counts.tasks)
  })

  it('keeps the rest as recent results: idle open Delegates, then the finished, and settled answers newest first', () => {
    const { recent } = workLists(VIEWS, ACTIVITY, INVOCATIONS)
    expect(ids(recent.delegates)).toEqual(['5', '7'])
    expect(recent.answers.map(({ persona }) => persona)).toEqual([3, 1])
  })

  it('shows the newest ten settled answers', () => {
    const settled = Array.from({ length: 12 }, (_, index) => invocation(index + 1, 'answered', index))
    const { recent } = workLists([], {}, settled)
    expect(recent.answers.map(({ persona }) => persona)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
  })
})
