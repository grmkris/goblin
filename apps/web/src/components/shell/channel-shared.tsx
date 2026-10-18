import { useInfiniteQuery } from '@tanstack/react-query'
import type { ConversationView, TopicView } from '@goblin/contracts'
import { Button, Input } from '@goblin/ui'
import { FileIcon, ImageIcon, LinkIcon, RefreshCwIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SharedItem } from '../../lib/channel-shared.ts'
import { sharedPages, sharedQuery } from '../../conversations/shared.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { channelOf } from '../../lib/topics.ts'
import { useConversations, useTopics } from '../../lib/workspace/hooks.ts'
import { useOpenChat } from './panel.tsx'

export function ChannelShared({ topic }: { readonly topic: TopicView }) {
  const conversations = useConversations()
  const topics = useTopics()
  const chats = useMemo(
    () =>
      conversations
        .filter((view) => channelOf(view.id, conversations, topics) === topic.conversation)
        .toSorted((a, b) => Number(b.id === topic.conversation) - Number(a.id === topic.conversation)),
    [conversations, topic.conversation, topics],
  )
  const read = useInfiniteQuery(sharedQuery(chats))
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState('all')
  const items = useMemo(() => sharedPages(read.data?.pages ?? []), [read.data])
  const query = filter.trim().toLocaleLowerCase()
  const visible = items.filter(
    (item) =>
      (kind === 'all' || kind === item.kind) && `${item.name} ${item.detail}`.toLocaleLowerCase().includes(query),
  )
  return (
    <div className="channel-info-sections">
      <SharedToolbar
        filter={filter}
        onFilter={setFilter}
        pending={read.isRefetching}
        onRefresh={() => void read.refetch()}
      />
      <div className="channel-shared-filters" aria-label="Shared item type">
        {(['all', 'media', 'file', 'link'] as const).map((value) => (
          <Button
            key={value}
            variant={kind === value ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {{ all: 'All', media: 'Media', file: 'Files', link: 'Links' }[value]}
          </Button>
        ))}
      </div>
      <p className="channel-info-empty">Includes this channel and its threads.</p>
      {read.isPending && <p role="status">Reading shared items…</p>}
      {read.error !== null && <p role="alert">{messageOf(read.error, 'read shared items')}</p>}
      {read.isSuccess && visible.length === 0 && (
        <p className="channel-info-empty">
          {read.hasNextPage
            ? 'No matching items in the messages loaded so far.'
            : query !== ''
              ? 'No matching shared items.'
              : 'No shared items yet.'}
        </p>
      )}
      <ul className="channel-shared-list">
        {visible.map((item) => (
          <SharedRow key={item.key} item={item} chats={chats} />
        ))}
      </ul>
      {read.hasNextPage && (
        <Button variant="outline" pending={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
          Load more messages
        </Button>
      )}
      {read.isError && (
        <Button variant="outline" onClick={() => void read.refetch()}>
          Try again
        </Button>
      )}
    </div>
  )
}

function SharedToolbar({
  filter,
  onFilter,
  pending,
  onRefresh,
}: {
  readonly filter: string
  readonly onFilter: (value: string) => void
  readonly pending: boolean
  readonly onRefresh: () => void
}) {
  return (
    <div className="channel-shared-toolbar">
      <Input
        aria-label="Search loaded shared items"
        value={filter}
        placeholder="Search loaded items"
        onChange={(event) => onFilter(event.target.value)}
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        aria-label="Refresh shared items"
        title="Refresh shared items"
        pending={pending}
        onClick={onRefresh}
      >
        <RefreshCwIcon aria-hidden />
      </Button>
    </div>
  )
}

function SharedRow({ item, chats }: { readonly item: SharedItem; readonly chats: readonly ConversationView[] }) {
  const open = useOpenChat()
  return (
    <li key={item.key} className="channel-shared-item">
      <span className="channel-shared-icon" aria-hidden>
        {item.kind === 'link' ? <LinkIcon /> : item.kind === 'media' ? <ImageIcon /> : <FileIcon />}
      </span>
      <div className="channel-shared-copy">
        <a href={item.href} target="_blank" rel="noopener noreferrer">
          {item.name}
        </a>
        <small>{item.detail}</small>
        <button type="button" className="channel-info-link" onClick={() => open(item.conversation)}>
          Open {chats.find((chat) => chat.id === item.conversation)?.title ?? 'conversation'}
        </button>
      </div>
    </li>
  )
}
