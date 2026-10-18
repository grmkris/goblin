import type { ConversationView } from '@goblin/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { entryMessages, omittedEntries } from '../lib/entry-messages.ts'
import { sharedItems } from '../lib/channel-shared.ts'
import { isNumber, records } from '../lib/values.ts'

const sharedKeys = {
  channel: (chats: readonly ConversationView[]) =>
    ['conversations', 'shared', chats.map((chat) => [chat.id, chat.forkEntry, chat.lastReplyAt])] as const,
}

/** One bounded history page per request; a channel can be read all the way back, independently of compaction. */
export const sharedQuery = (chats: readonly ConversationView[]) =>
  infiniteQueryOptions({
    queryKey: sharedKeys.channel(chats),
    initialPageParam: { chat: 0, before: Number.MAX_SAFE_INTEGER },
    queryFn: async ({ pageParam, signal }) => {
      const chat = chats.at(pageParam.chat)
      if (chat === undefined) return { chat: '', entries: [], next: undefined }
      const page = await owner.run(
        (api) => api.conversations.history({ params: { id: chat.id }, query: { before: pageParam.before } }),
        signal,
      )
      const entries = records(page.entries)
      const oldest = entries[0]?.id
      // Forks retain inherited entries. Index only their own portion; the channel already owns the earlier messages.
      const more = page.more && isNumber(oldest) && oldest < pageParam.before && oldest > (chat.forkEntry ?? 0)
      const next = more
        ? { chat: pageParam.chat, before: oldest }
        : pageParam.chat + 1 < chats.length
          ? { chat: pageParam.chat + 1, before: Number.MAX_SAFE_INTEGER }
          : undefined
      return {
        chat: chat.id,
        entries: entries.filter(
          (entry) => chat.forkEntry === undefined || (isNumber(entry.id) && entry.id >= chat.forkEntry),
        ),
        next,
      }
    },
    getNextPageParam: (page) => page.next,
    staleTime: 0,
  })

/** Later edits also omit entries in earlier pages. A fork's inherited entry shares its source's stable entry id. */
export function sharedPages(
  pages: readonly { readonly chat: string; readonly entries: readonly Record<string, unknown>[] }[],
) {
  const byChat = new Map<string, Record<string, unknown>[]>()
  for (const page of pages) byChat.set(page.chat, [...page.entries, ...(byChat.get(page.chat) ?? [])])
  const seen = new Set<string>()
  return [...byChat]
    .flatMap(([chat, entries]) => sharedItems(entryMessages(entries, omittedEntries(entries)), chat))
    .filter((item) => {
      if (seen.has(item.key)) return false
      seen.add(item.key)
      return true
    })
}
