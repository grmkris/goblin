// The service shelf stays visible. Search and address entry are direct, reversible actions above it.
import { useId, useRef, useState } from 'react'
import type { ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { LinkIcon, SearchIcon, XIcon } from 'lucide-react'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { AddByAddress, SuggestedServers } from './server-add.tsx'
import { ServerSearch } from './server-search.tsx'

type PickerAction = 'search' | 'address'

export function ServerPicker({
  onChanged,
  onAdded,
  onMessage,
}: {
  readonly onChanged: (message: string) => void
  readonly onAdded: (server: ServerView) => void
  readonly onMessage: (message: string) => void
}) {
  const [action, setAction] = useState<PickerAction>()
  const panel = useId()
  const search = useRef<HTMLButtonElement>(null)
  const address = useRef<HTMLButtonElement>(null)
  const close = () => {
    setAction(undefined)
    const trigger = action === 'search' ? search : address
    trigger.current?.focus()
  }
  const toggle = (next: PickerAction) => setAction(action === next ? undefined : next)
  return (
    <div className="server-picker">
      <div className="picker-toolbar">
        <p>Give goblin a few more ways to help. You choose which tools it can use.</p>
        <div className="picker-actions">
          <Button
            ref={search}
            variant="ghost"
            aria-expanded={action === 'search'}
            aria-controls={panel}
            onClick={() => toggle('search')}
          >
            <SearchIcon data-icon="inline-start" aria-hidden />
            Search catalogue
          </Button>
          <Button
            ref={address}
            variant="ghost"
            aria-expanded={action === 'address'}
            aria-controls={panel}
            onClick={() => toggle('address')}
          >
            <LinkIcon data-icon="inline-start" aria-hidden />
            Add by address
          </Button>
        </div>
      </div>
      <div id={panel} hidden={action === undefined} className="picker-panel">
        {action !== undefined && (
          <>
            <div className="picker-panel-head">
              <h3>{action === 'search' ? 'Find a service' : 'Add your own server'}</h3>
              <Button variant="ghost" size="icon" aria-label="Close server search or address entry" onClick={close}>
                <XIcon aria-hidden />
              </Button>
            </div>
            {action === 'search' ? (
              <ServerSearch onChanged={onChanged} onMessage={onMessage} />
            ) : (
              <AddByAddress onAdded={onAdded} onMessage={onMessage} />
            )}
          </>
        )}
      </div>
      <QueryBoundary action="list the suggested servers" pending={<p className="server-note">Loading services…</p>}>
        <SuggestedServers preview onChanged={onChanged} onMessage={onMessage} />
      </QueryBoundary>
    </div>
  )
}
