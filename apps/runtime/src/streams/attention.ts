import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  type AttentionDetail,
  type AttentionItem,
  type AttentionReason,
  NotInTopic,
  type PersonaAnswerData,
  itemLabel,
} from '@goblin/contracts'
import { Predicate } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { heldCall } from '../attention.ts'
import { askedQuestions } from '../pi/entry-view.ts'

// `/attention`: what in a chat waits for a person, read from the chat's own entries by goblin's markers only (the
// same markers Activity reads, `attention.ts`), as AG-UI interrupts.

const LABEL = 200
const label = (text: string): string => (text.length > LABEL ? `${text.slice(0, LABEL - 1)}…` : text)
const notInTopic = Schema.decodeUnknownOption(NotInTopic)

/** The interrupt id of what `entry` raised in `chat`: one per entry, stable while it stays open. */
export const attentionId = (chat: string, entry: number): string => `${chat}:i${entry}`

/** How a held call reads: its connection, then what it waits on. */
const heldLabel = (reason: AttentionReason, connectionId: string, name: string): string =>
  `${connectionId} · ${reason === 'access' ? 'more access' : reason === 'connect' ? 'sign in' : name}`

/** A held call's fields of an item: its connection and tool, and the held call's, URL request's or scope's own. */
const heldDetail = (held: {
  readonly connectionId: string
  readonly name: string
  readonly approvalId?: string | undefined
  readonly requestId?: string | undefined
  readonly scope?: string | undefined
}) => ({
  connectionId: held.connectionId,
  name: held.name,
  ...(held.approvalId === undefined ? {} : { approvalId: held.approvalId }),
  ...(held.requestId === undefined ? {} : { requestId: held.requestId }),
  ...(held.scope === undefined ? {} : { scope: held.scope }),
})

/** The item `entry` raises in `chat`, about `toolCallId` when a tool's result raised it. */
const item = (
  chat: string,
  entry: EntryRecord,
  raised: { readonly reason: AttentionReason; readonly message: string; readonly toolCallId?: string },
  detail: Omit<AttentionDetail, 'entryId'>,
): AttentionItem => ({
  id: attentionId(chat, Number(entry.id)),
  reason: raised.reason,
  message: label(raised.message),
  ...(raised.toolCallId === undefined ? {} : { toolCallId: raised.toolCallId }),
  metadata: { goblin: { entryId: Number(entry.id), ...detail } },
})

/** The tool result of `entry` that raised something: its call, and goblin's own details (a remote result has `origin`). */
function markedResult(entry: EntryRecord) {
  for (const message of entry.model ?? []) {
    if (message.role !== 'toolResult') continue
    const details = message.details
    if (Predicate.isReadonlyObject(details) && !('origin' in details)) return { message, details }
  }
  return undefined
}

/** What a tool result raised: `ask_user`'s questions, a held call, or something outside the Topic's setup. */
function toolRaised(chat: string, entry: EntryRecord): AttentionItem | undefined {
  const marked = markedResult(entry)
  if (marked === undefined) return undefined
  const toolCallId = marked.message.toolCallId
  const questions = askedQuestions(entry)
  if (questions !== undefined && !marked.message.isError)
    return item(
      chat,
      entry,
      { reason: 'question', message: questions[0]?.prompt ?? 'A question', toolCallId },
      { questions },
    )
  const held = heldCall(entry)
  if (held !== undefined) {
    const message = heldLabel(held.kind, held.connectionId, held.name)
    return item(chat, entry, { reason: held.kind, message, toolCallId }, heldDetail(held))
  }
  if (!marked.message.isError) return undefined
  return Option.match(notInTopic(marked.details), {
    onNone: () => undefined,
    onSome: ({ target, topic }) =>
      item(chat, entry, { reason: 'setup', message: `Add ${itemLabel(target)} to #${topic.name}`, toolCallId }, {}),
  })
}

/** What a Persona's answer stopped on (ADR 0041) or asked (ADR 0082), as its Persona's item. */
function personaRaised(chat: string, entry: EntryRecord, answer: PersonaAnswerData): AttentionItem | undefined {
  const { hold, questions, persona } = answer
  if (hold !== undefined) {
    const message = `${answer.name}: ${heldLabel(hold.kind, hold.connectionId, hold.name)}`
    return item(chat, entry, { reason: hold.kind, message }, { persona, fork: hold.fork, ...heldDetail(hold) })
  }
  if (questions === undefined || questions.length === 0) return undefined
  const message = `${answer.name}: ${questions[0]?.prompt ?? 'A question'}`
  return item(chat, entry, { reason: 'question', message }, { persona, questions })
}

/**
 * `open` after `entry`: the owner's own message settles everything before it (as the web's cards and Activity do),
 * a Persona's answer settles that Persona's earlier item, a held call's outcome the items on that call, and whatever
 * the entry raises is added. `answer` is the entry's Persona answer, when it is one.
 */
export function settleAttention(
  chat: string,
  open: readonly AttentionItem[],
  entry: EntryRecord,
  answer: PersonaAnswerData | undefined,
  outcome: { readonly connectionId: string; readonly name: string } | undefined,
): readonly AttentionItem[] {
  if (entry.kind === 'pi.user' && outcome === undefined) return []
  const kept = open.filter(({ metadata: { goblin } }) =>
    answer !== undefined
      ? goblin.persona !== answer.persona
      : outcome === undefined || goblin.connectionId !== outcome.connectionId || goblin.name !== outcome.name,
  )
  const raised = answer === undefined ? toolRaised(chat, entry) : personaRaised(chat, entry, answer)
  return raised === undefined ? kept : [...kept, raised]
}
