import type { EntryRecord } from '@earendil-works/pi-durable'
import { openAttention } from '../streams/attention.ts'
import { entryMessages } from '../streams/messages.ts'

/**
 * What a working send does now, in plain words (ADR 0119), from its chat's newest entries, oldest first: `waiting for
 * a person` while an item there waits for one (a Persona's question, a held call, an approval: the chat's STATE
 * `/attention`), else `calling <tool>` while a tool it called has no result yet, else `thinking`. Pure: it reads only
 * what was committed, so a tool's name shows once its call is in the transcript.
 */
export function stepOf(chat: string, entries: readonly EntryRecord[]): string {
  if (openAttention(chat, entries).length > 0) return 'waiting for a person'
  const messages = entries.flatMap((entry) => entryMessages(chat, entry))
  const answered = new Set(messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : [])))
  const open = messages
    .flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
    .findLast((call) => !answered.has(call.id))
  return open === undefined ? 'thinking' : `calling ${open.function.name}`
}
