import type { ConversationView, PersonaInvocationView } from '@goblin/contracts'
import { delegates, personaTasks } from './rail.ts'
import { type Activity, activityOf, answering } from './workspace/slices.ts'

/** How many settled Persona answers Work's Recent results show. */
const RECENT_ANSWERS = 10

/** One of Work's lists of delegated work: the Delegates (subagents) and the Persona answers, kept apart. */
export type WorkList = {
  readonly delegates: readonly ConversationView[]
  readonly answers: readonly PersonaInvocationView[]
}

/**
 * Work's delegated work, from the workspace feed. Running is what Work's count counts: the Delegates at work (or
 * waiting on their own subagents) and the Persona answers on their way, in the order they were asked. Recent results
 * are the rest: the open Delegates that are not at work, then the finished ones, newest first, and the newest settled
 * Persona answers.
 */
export function workLists(
  views: readonly ConversationView[],
  activity: Activity,
  invocations: readonly PersonaInvocationView[],
): { readonly running: WorkList; readonly recent: WorkList } {
  const { active, finished } = delegates(views, activity)
  const busy = (view: ConversationView) => activityOf(activity, view.id) !== undefined
  const answers = personaTasks(invocations)
  return {
    running: { delegates: active.filter(busy), answers: answers.filter(answering) },
    recent: {
      delegates: [...active.filter((view) => !busy(view)), ...finished],
      answers: answers.filter((each) => !answering(each)).slice(0, RECENT_ANSWERS),
    },
  }
}
