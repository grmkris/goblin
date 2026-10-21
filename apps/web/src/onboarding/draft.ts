import { ServerGroup } from '@goblin/contracts'
import { Conflict, InvalidInput } from '@goblin/contracts/api'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useState } from 'react'

import { workspaceKey } from '../lib/workspace-path.ts'

/** Kept per workspace (ADR 0089): each has its own Start. */
const key = () => workspaceKey('start-draft')

/** Only these typed kickoff refusals prove no channel was created. A generic 400/409 may follow a partial kickoff. */
export const kickoffAllowsEdit = (error: unknown): boolean =>
  (Schema.is(Conflict)(error) && error.reason === 'topic_name_taken') ||
  (Schema.is(InvalidInput)(error) && ['empty_message', 'topic_name'].includes(error.reason))

/** What the owner is starting with: their goal, the channel's name and the service groups worth showing first. */
const StartDraft = Schema.Struct({
  goal: Schema.String,
  channel: Schema.String,
  groups: Schema.Array(ServerGroup),
  /** The kickoff's operation once it was sent: the draft is frozen until it is refused or done. */
  operation: Schema.String,
})
export type StartDraft = typeof StartDraft.Type

/** A goal to start from, with the channel it names and the services it suggests first. */
export type StartIdea = Pick<StartDraft, 'goal' | 'channel' | 'groups'>

const empty = (): StartDraft => ({
  goal: '',
  channel: 'My first project',
  groups: ['yours', 'knowledge'],
  operation: '',
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(StartDraft))

/** Kept in this tab across model setup and a connection's OAuth return; never stores a model key. */
function read(): StartDraft {
  try {
    return Option.getOrElse(decode(sessionStorage.getItem(key()) ?? ''), empty)
  } catch {
    // expected: storage can be unavailable
    return empty()
  }
}

export function clearStartDraft(): void {
  try {
    sessionStorage.removeItem(key())
  } catch {
    /* expected: storage is unavailable */
  }
}

export function useStartDraft() {
  const [draft, setDraft] = useState(read)
  const store = (next: StartDraft) => {
    setDraft(next)
    try {
      sessionStorage.setItem(key(), JSON.stringify(next))
    } catch {
      /* expected: storage is unavailable; the mounted page keeps the draft */
    }
    return next
  }
  const editable = draft.operation === ''
  return {
    draft,
    edit: (change: Partial<Pick<StartDraft, 'goal' | 'channel'>>) =>
      editable ? store({ ...draft, ...change }) : draft,
    pick: ({ goal, channel, groups }: StartIdea) => (editable ? store({ ...draft, goal, channel, groups }) : draft),
    rejected: () => store({ ...draft, operation: '' }),
    begin: () => (editable ? store({ ...draft, operation: crypto.randomUUID() }) : draft),
  }
}
