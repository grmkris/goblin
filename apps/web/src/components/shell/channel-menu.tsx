import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { TopicView, UpdateTopic } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { ArchiveIcon, ArchiveRestoreIcon, EllipsisIcon, PencilIcon } from 'lucide-react'
import { messageOf } from '../../lib/query/app-error.ts'
import { isArchived } from '../../lib/topics.ts'
import { updateWorkspaceTopicMutation } from '../../lib/workspace/mutations.ts'
import { TopicDialog } from './topic-dialog.tsx'

/**
 * A channel's actions, in its info panel's header: rename, and archive it or restore it (never Personal). Whether it is
 * sealed or a hub is the Overview's (`ChannelReach`). A failure shows in the panel and under the chat's bar.
 */
export function ChannelMenu({
  topic,
  onFailure,
}: {
  readonly topic: TopicView
  readonly onFailure: (text: string) => void
}) {
  const update = useMutation(updateWorkspaceTopicMutation)
  const [renaming, setRenaming] = useState(false)
  const change = (patch: UpdateTopic) =>
    update.mutate(
      { id: topic.id, change: patch },
      { onError: (failure) => onFailure(messageOf(failure, 'change the topic')) },
    )
  const archived = isArchived(topic)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`Actions for #${topic.name}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <PencilIcon aria-hidden />
            Rename
          </DropdownMenuItem>
          {topic.personal !== true && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => change({ archived: !archived })}>
                {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
                {archived ? 'Restore topic' : 'Archive topic'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming && <TopicDialog open onOpenChange={setRenaming} topic={topic} />}
    </>
  )
}

/**
 * In place of an archived Topic's composer: it is archived, and Restore brings it back to the sidebar and to search.
 * Nothing that was stopped starts again on its own.
 */
export function ArchivedBanner({
  topic,
  onFailure,
}: {
  readonly topic: TopicView
  readonly onFailure: (text: string) => void
}) {
  const restore = useMutation(updateWorkspaceTopicMutation)
  return (
    <div className="chat-dock">
      <div className="chat-closed" role="status">
        <span>#{topic.name} is archived.</span>
        <Button
          variant="outline"
          size="sm"
          pending={restore.isPending}
          onClick={() =>
            restore.mutate(
              { id: topic.id, change: { archived: false } },
              { onError: (failure) => onFailure(messageOf(failure, 'restore the topic')) },
            )
          }
        >
          <ArchiveRestoreIcon data-icon="inline-start" />
          Restore
        </Button>
      </div>
    </div>
  )
}
