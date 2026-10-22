import type { EntryRecord } from '@earendil-works/pi-durable'
import { type AttentionItem, type ConversationUpdated, PERSONAL_TOPIC } from '@goblin/contracts'
import { settleAttention } from '../streams/attention.ts'
import { outcomeOf, personaAnswer } from '../streams/messages.ts'

// What a chat's `conversation.updated` says (ADR 0112), from what was read of it: its entries folded for its attention
// and newest entry, and whether anything works in it. Pure, and apart from the journal and the deliveries
// (`journal.ts`), which take the ready payload: whatever reads a chat's Pi state reports the same wake. A chat id is
// opaque here, and entries are compared only within their own chat.

/** What a chat's attention fold has read: past which entry, and the items open after it. */
export type AttentionFold = { readonly last: number; readonly open: readonly AttentionItem[] }

/**
 * `fold` advanced over `entries` (from nothing when there is none): each entry past its last once, in order, settled as
 * the chat's stream settles `/attention` (`streams/attention.ts`), so the count is its STATE's.
 */
export function foldAttention(
  chat: string,
  fold: AttentionFold | undefined,
  entries: readonly EntryRecord[],
): AttentionFold {
  let { last, open } = fold ?? { last: 0, open: [] }
  for (const entry of entries) {
    const id = Number(entry.id)
    if (fold !== undefined && id <= fold.last) continue
    open = settleAttention(chat, open, entry, personaAnswer(entry), outcomeOf(entry))
    last = Math.max(last, id)
  }
  return { last, open }
}

/** Whether two wakes of a chat say the same: then none goes out. */
export const sameWake = (left: ConversationUpdated, right: ConversationUpdated): boolean =>
  left.chat === right.chat &&
  left.topic === right.topic &&
  left.entry === right.entry &&
  left.activity === right.activity &&
  left.attention === right.attention

/** A chat as its wake names it: its id and its Topic. */
export type WakeChat = { readonly chat: string; readonly topicId: number }

/** The wake of `chat` after `fold`, working or not: its Topic's id as text, none in Personal. */
export const wakeOf = (chat: WakeChat, fold: AttentionFold, working: boolean): ConversationUpdated => ({
  chat: chat.chat,
  topic: chat.topicId === PERSONAL_TOPIC ? null : String(chat.topicId),
  entry: fold.last,
  activity: working ? 'working' : 'idle',
  attention: fold.open.length,
})

/** The Topic a wake names: Personal when it names none. */
export const topicOfWake = (wake: ConversationUpdated): number =>
  wake.topic === null ? PERSONAL_TOPIC : Number(wake.topic)
