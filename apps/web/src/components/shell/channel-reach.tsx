import { useMutation } from '@tanstack/react-query'
import type { TopicView } from '@goblin/contracts'
import { Switch } from '@goblin/ui'
import { useConfigures } from '../../lib/current-workspace.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { reachChange, reachNote } from '../../lib/topics.ts'
import { updateWorkspaceTopicMutation } from '../../lib/workspace/mutations.ts'

/**
 * How far a Topic's chats reach (ADR 0115), at the top of its Overview: every Topic is sealed, so goblin there sees only
 * that Topic, and a hub reaches every Topic. A quiet line for a member; for an owner or an admin a switch that makes the
 * Topic a hub or seals it again. A failure shows in the panel and under the chat's bar.
 */
export function ChannelReach({
  topic,
  onFailure,
}: {
  readonly topic: TopicView
  readonly onFailure: (text: string) => void
}) {
  const update = useMutation(updateWorkspaceTopicMutation)
  const configures = useConfigures()
  const hub = topic.reach === 'hub'
  const state = hub ? 'Hub' : 'Sealed'
  if (!configures)
    return (
      <p className="channel-info-reach">
        <span className="channel-info-reach-name">{state}:</span> {reachNote(topic)}
      </p>
    )
  return (
    <label className="switch-row channel-info-reach-row" data-disabled={update.isPending || undefined}>
      <span className="switch-name">
        <span className="channel-info-reach-name">{state}</span>
        <span className="switch-detail">{reachNote(topic)}</span>
      </span>
      <Switch
        checked={hub}
        disabled={update.isPending}
        aria-busy={update.isPending}
        aria-label="Hub"
        onCheckedChange={(on) =>
          update.mutate(
            { id: topic.id, change: reachChange(on) },
            { onError: (failure) => onFailure(messageOf(failure, "change this Topic's reach")) },
          )
        }
      />
    </label>
  )
}
