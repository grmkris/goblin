import {
  AssistantEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Tx,
} from '@earendil-works/pi-durable'
import type { PersonaHold, QuestionSpec } from '@goblin/contracts'
import { heldCall } from '../attention.ts'
import { entryId } from './context.ts'
import { askedQuestions } from './entry-view.ts'
import { answerText } from './subagent-relay.ts'

/**
 * What a Persona's fork answered (ADR 0033): its words, what it stopped on when it needs the owner first (ADR 0041),
 * and what it asked with `ask_user` (ADR 0082).
 */
export type ForkAnswer = {
  readonly text: string
  readonly hold?: PersonaHold
  readonly questions?: readonly QuestionSpec[]
}

/** A hold as an entry keeps it: JSON with no key left undefined. */
export const holdJson = ({ kind, approvalId, requestId, scope, connectionId, name, fork }: PersonaHold) => ({
  kind,
  connectionId,
  name,
  fork,
  ...(approvalId === undefined ? {} : { approvalId }),
  ...(requestId === undefined ? {} : { requestId }),
  ...(scope === undefined ? {} : { scope }),
})

/** What a Persona's answer says when it stopped on a hold without words of its own. */
const HOLD_TEXT: Readonly<Record<PersonaHold['kind'], string>> = {
  approval: 'I need your approval for this call before I can go on.',
  grant: 'I need you to allow this tool before I can go on.',
  url: 'I need you to finish a step on the server’s site before I can go on.',
  access: 'I need you to sign in to this connection again with more access before I can go on.',
  connect: 'I need you to connect this before I can go on.',
}

/** The fork's entries since the owner's ask reached it, oldest first; none when the ask is not there. */
async function sinceAsk(tx: Tx, fork: ConversationId, requestId: string): Promise<readonly EntryRecord[]> {
  const asked = await tx.submissionByRequest(fork, requestId)
  if (asked?.entry === undefined) return []
  return (await tx.scanEntries({ conversationId: fork, minEntryId: entryId(Number(asked.entry) + 1) }, 50)).items
}

/**
 * What the fork answered since it was asked, from its final answer and goblin's own markers: the first call it held
 * for the owner and the last questions it asked. None when it has no words, held nothing and asked nothing.
 */
export async function readAnswer(
  tx: Tx,
  fork: ConversationId,
  requestId: string,
  answer: EntryId | undefined,
): Promise<ForkAnswer | undefined> {
  const entry = answer === undefined ? undefined : await tx.entry(AssistantEntry, answer)
  const since = await sinceAsk(tx, fork, requestId)
  const held = since.map(heldCall).find((call) => call !== undefined)
  const hold = held === undefined ? undefined : holdJson({ ...held, fork: String(fork) })
  const questions = since.map(askedQuestions).findLast((asked) => asked !== undefined)
  const text = answerText(entry).trim() || (hold === undefined ? '' : HOLD_TEXT[hold.kind])
  if (text === '' && questions === undefined) return undefined
  return { text, ...(hold === undefined ? {} : { hold }), ...(questions === undefined ? {} : { questions }) }
}
