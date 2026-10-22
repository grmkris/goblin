import type { ConversationView } from '@goblin/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { type Wire, chatMessages, entriesOf, marksOf } from '../lib/agui/messages.ts'
import { sharedItems } from '../lib/channel-shared.ts'
import { records } from '../lib/values.ts'

const sharedKeys = {
  channel: (chats: readonly ConversationView[]) =>
    ['conversations', 'shared', chats.map((chat) => [chat.id, chat.forkEntry, chat.lastReplyAt])] as const,
}

/** Whether a fork's message is its own: at or after the entry it forked at (reasoning marks none; it goes with its answer). */
const fromFork = (message: Wire, forkEntry: number): boolean => (marksOf(message).entryId ?? forkEntry) >= forkEntry

/** One bounded history page per request; a channel can be read all the way back, independently of compaction. */
export const sharedQuery = (chats: readonly ConversationView[]) =>
  infiniteQueryOptions({
    queryKey: sharedKeys.channel(chats),
    initialPageParam: { chat: 0, before: Number.MAX_SAFE_INTEGER },
    queryFn: async ({ pageParam, signal }) => {
      const chat = chats.at(pageParam.chat)
      if (chat === undefined) return { chat: '', messages: [], next: undefined }
      const page = await owner.run(
        (api) => api.conversations.history({ params: { id: chat.id }, query: { before: pageParam.before } }),
        signal,
      )
      const messages = records(page.messages)
      const oldest = page.next
      // Forks retain inherited entries. Index only their own portion; the channel already owns the earlier messages.
      const more = page.more && oldest < pageParam.before && oldest > (chat.forkEntry ?? 0)
      const next = more
        ? { chat: pageParam.chat, before: oldest }
        : pageParam.chat + 1 < chats.length
          ? { chat: pageParam.chat + 1, before: Number.MAX_SAFE_INTEGER }
          : undefined
      const { forkEntry } = chat
      return {
        chat: chat.id,
        messages: forkEntry === undefined ? messages : messages.filter((message) => fromFork(message, forkEntry)),
        next,
      }
    },
    getNextPageParam: (page) => page.next,
    staleTime: 0,
  })

/**
 * Later edits also omit entries in earlier pages. Each item is kept once by its key (entry id and target): a link twice
 * in one message, a fork's branch entry, which shares its source's entry id, and an entry moved into a thread, which
 * keeps its id there.
 */
export function sharedPages(pages: readonly { readonly chat: string; readonly messages: readonly Wire[] }[]) {
  const byChat = new Map<string, Wire[]>()
  for (const page of pages) byChat.set(page.chat, [...page.messages, ...(byChat.get(page.chat) ?? [])])
  const seen = new Set<string>()
  return [...byChat]
    .flatMap(([chat, messages]) => sharedItems(chatMessages(messages, entriesOf(messages).omitted), chat))
    .filter((item) => {
      if (seen.has(item.key)) return false
      seen.add(item.key)
      return true
    })
}
