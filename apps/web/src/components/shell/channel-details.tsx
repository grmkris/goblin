import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { TopicView } from '@goblin/contracts'
import { Button, Textarea } from '@goblin/ui'
import { CheckIcon, PencilIcon, XIcon } from 'lucide-react'
import { useConfigures } from '../../lib/current-workspace.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { updateWorkspaceTopicMutation } from '../../lib/workspace/mutations.ts'

/** A Topic's description and guidance, which the agent reads as its purpose: an admin's to change (ADR 0098). */
export function ChannelDetails({ topic }: { readonly topic: TopicView }) {
  const update = useMutation(updateWorkspaceTopicMutation)
  const configures = useConfigures()
  const [editing, setEditing] = useState(false)
  const [revision, setRevision] = useState(topic.revision)
  const [description, setDescription] = useState(topic.description ?? '')
  const [instructions, setInstructions] = useState(topic.instructions ?? '')
  const failure = update.error === null ? '' : messageOf(update.error, 'save channel details')
  const edit = () => {
    setDescription(topic.description ?? '')
    setInstructions(topic.instructions ?? '')
    setRevision(topic.revision)
    setEditing(true)
    update.reset()
  }
  if (!editing) return <DetailsSummary topic={topic} onEdit={configures ? edit : undefined} />
  return (
    <form
      className="channel-info-editor"
      onSubmit={(event) => {
        event.preventDefault()
        update.mutate(
          {
            id: topic.id,
            change: { description, instructions, expectedRevision: revision },
          },
          { onSuccess: () => setEditing(false) },
        )
      }}
    >
      <label>
        <span>Description</span>
        <Textarea
          value={description}
          maxLength={1000}
          rows={2}
          placeholder="What belongs here?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        <span>Instructions</span>
        <Textarea
          value={instructions}
          maxLength={8000}
          rows={4}
          placeholder="How should goblin help?"
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {topic.revision !== revision && <DetailsConflict topic={topic} onReplace={() => setRevision(topic.revision)} />}
      {failure !== '' && (
        <p className="channel-info-error" role="alert">
          {failure}
        </p>
      )}
      <div className="channel-info-actions">
        <Button type="button" variant="ghost" disabled={update.isPending} onClick={() => setEditing(false)}>
          <XIcon data-icon="inline-start" />
          Cancel
        </Button>
        <Button type="submit" pending={update.isPending} disabled={topic.revision !== revision}>
          <CheckIcon data-icon="inline-start" />
          Save details
        </Button>
      </div>
    </form>
  )
}

/** The details as they are, with Edit for an admin (`onEdit`) and why there is none for a member. */
function DetailsSummary({ topic, onEdit }: { readonly topic: TopicView; readonly onEdit: (() => void) | undefined }) {
  return (
    <div className="channel-info-details">
      <div className="channel-info-detail-row">
        <span className="channel-info-label">Description</span>
        <span className="channel-info-value">{topic.description || 'Add a short purpose for this channel.'}</span>
      </div>
      <div className="channel-info-detail-row">
        <span className="channel-info-label">Instructions</span>
        <span className="channel-info-value">
          {topic.instructions || 'Add guidance for how goblin should work here.'}
        </span>
      </div>
      {onEdit === undefined ? (
        <p className="channel-info-value">Only the workspace's owners and admins change a channel's details.</p>
      ) : (
        <Button variant="outline" size="sm" onClick={onEdit}>
          <PencilIcon data-icon="inline-start" />
          Edit details
        </Button>
      )}
    </div>
  )
}

function DetailsConflict({ topic, onReplace }: { readonly topic: TopicView; readonly onReplace: () => void }) {
  return (
    <div role="status" className="channel-info-conflict">
      <p>Channel details changed elsewhere. Your draft is kept below.</p>
      <details>
        <summary>Review current details</summary>
        <p>{topic.description || 'No description'}</p>
        <p>{topic.instructions || 'No instructions'}</p>
        <Button type="button" variant="outline" onClick={onReplace}>
          Use my draft over these details
        </Button>
      </details>
    </div>
  )
}
