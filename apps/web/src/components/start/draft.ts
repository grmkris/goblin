import { useState } from 'react'
import { record } from '../../lib/values.ts'

const KEY = 'goblin:start-draft'
export type StartDraft = {
  readonly goal: string
  readonly channel: string
  /** The kickoff's operation once it was sent: the draft is frozen until it is refused or done. */
  readonly operation: string
}
const empty = (): StartDraft => ({ goal: '', channel: 'My first project', operation: '' })

/** Kept in this tab across model setup and a connection's OAuth return; never stores a model key. */
function read(): StartDraft {
  try {
    const value = record(JSON.parse(sessionStorage.getItem(KEY) ?? 'null'))
    if (
      value === undefined ||
      typeof value.goal !== 'string' ||
      typeof value.channel !== 'string' ||
      typeof value.operation !== 'string'
    )
      return empty()
    return {
      goal: value.goal.slice(0, 2000),
      channel: value.channel.slice(0, 80),
      operation: value.operation,
    }
  } catch {
    // expected: storage can be unavailable, or a draft from an interrupted write can be unreadable
    return empty()
  }
}

export function clearStartDraft(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* expected: storage is unavailable */
  }
}

export function useStartDraft() {
  const [draft, setDraft] = useState(read)
  const store = (next: StartDraft) => {
    setDraft(next)
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* expected: storage is unavailable; the mounted page keeps the draft */
    }
    return next
  }
  return {
    draft,
    edit: (change: Partial<Pick<StartDraft, 'goal' | 'channel'>>) =>
      draft.operation === '' ? store({ ...draft, ...change }) : draft,
    rejected: () => store({ ...draft, operation: '' }),
    begin: () => (draft.operation === '' ? store({ ...draft, operation: crypto.randomUUID() }) : draft),
  }
}

/** Suggestions describe the owner's intent; no model call or connection is needed to get started. */
export function suggestedChannel(goal: string): string {
  if (/trip|travel|booking|holiday|flight|moving/iu.test(goal)) return 'Travel plans'
  if (/research|learn|read|write|study/iu.test(goal)) return 'Research'
  if (/train|fitness|run|workout/iu.test(goal)) return 'Training'
  return 'My first project'
}
