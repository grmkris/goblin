import { useQuery } from '@tanstack/react-query'
import { channelChatsQuery, channelQuery } from './queries.ts'

/** The Telegram channel's chats and topics (ADR 0055) while it is on, read for the connection that carries it. */
export function useTelegramChats() {
  const channel = useQuery(channelQuery).data
  return useQuery(channelChatsQuery(channel?.connectionId))
}
