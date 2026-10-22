import { useState } from 'react'
import type { QueueItem } from '@goblin/contracts'
import { selectionKey } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { Trash2Icon } from 'lucide-react'
import { contextPreview } from '../lib/app-context.ts'
import { reportUnexpected } from '../lib/unexpected.ts'
import { MessageFiles } from './attachments.tsx'

/** Queued inputs belong beside the composer; they become transcript messages only when their turn takes them. */
export function QueuedMessages({
  inputs,
  onRemove,
}: {
  readonly inputs: readonly QueueItem[]
  readonly onRemove?: (id: number) => Promise<boolean>
}) {
  if (inputs.length === 0) return null
  return (
    <section className="queued-messages" aria-label="Queued messages">
      <p className="queue-heading" role="status">
        Queued · {inputs.length}
      </p>
      <ol>
        {inputs.map((input, index) => {
          const context = input.context ?? []
          return (
            <li key={input.id} data-submission={input.id}>
              <div className="queue-meta">
                <span>
                  {input.author ?? 'You'} · {input.mode === 'steer' ? 'Steering' : 'Follow-up'}
                </span>
                {onRemove !== undefined && <RemoveQueued id={input.id} index={index} onRemove={onRemove} />}
              </div>
              <details>
                <summary aria-label={`Expand queued message ${index + 1}`}>
                  <span className="queue-preview">{input.text || 'Selected skill'}</span>
                </summary>
              </details>
              {input.attachments !== undefined && <MessageFiles files={input.attachments} />}
              {(input.selections?.length ?? 0) > 0 && (
                <ul className="queue-references" aria-label="Selected references">
                  {input.selections?.map((option) => (
                    <li key={selectionKey(option.selection)}>
                      {option.selection.kind === 'skill' ? '/' : '@'}
                      {option.label}
                    </li>
                  ))}
                </ul>
              )}
              {context.length > 0 && (
                <ul className="queue-references" aria-label="Shared context">
                  {context.map((shared, at) => (
                    <li key={`${at}:${shared.from}`} title={shared.text}>
                      {shared.from} · {contextPreview(shared.text)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** Removal disables only its own row; another queued input remains independently removable. */
function RemoveQueued({
  id,
  index,
  onRemove,
}: {
  readonly id: number
  readonly index: number
  readonly onRemove: (id: number) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Remove queued message ${index + 1}`}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true)
        onRemove(id)
          .finally(() => setBusy(false))
          .catch(reportUnexpected)
      }}
    >
      <Trash2Icon aria-hidden />
    </Button>
  )
}
