// A connection's Sources (ADR 0066), on its card under its Events: each Source set up on it, with its card (its facts,
// Confirm while proposed, Pause, Resume and Remove) and its conversations. The agent proposes one (`source_propose`):
// no server suggests a setup (ADR 0068), so the section is there once one is proposed.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerView, SourceView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { sourceStatus } from '../lib/source-routes.ts'
import { sourcesQuery } from '../sources/queries.ts'
import { SourceReview } from './source-review.tsx'
import { SourceRoutes } from './source-routes.tsx'
import { StatusLabel } from './status-label.tsx'

/** What a Source's row has open under it: its card, its conversations, or nothing. */
type Opened = 'card' | 'routes' | undefined

/**
 * One Source on the connection: its name and where it stands, Review (its card) and, once confirmed, Conversations. A
 * proposal opens on its card, since it waits for the owner's review.
 */
function SourceRow({ source }: { readonly source: SourceView }) {
  const [opened, setOpened] = useState<Opened>(source.state === 'proposed' ? 'card' : undefined)
  const toggle = (next: Exclude<Opened, undefined>) => setOpened(opened === next ? undefined : next)
  const confirmed = source.state === 'active' || source.state === 'paused'
  return (
    <li className="event-set">
      <span className="event-set-text">
        <span className="event-set-title">{source.title}</span>
        {source.waiting.length > 0 && (
          <span className="event-pick-about">
            {source.waiting.length === 1
              ? '1 conversation waits for you to say where it goes'
              : `${String(source.waiting.length)} conversations wait for you to say where they go`}
          </span>
        )}
      </span>
      <span className="event-set-side">
        <StatusLabel label={sourceStatus(source)} />
        <span className="row-actions">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={opened === 'card'}
            onClick={() => toggle('card')}
          >
            Review
          </Button>
          {confirmed && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={opened === 'routes'}
              onClick={() => toggle('routes')}
            >
              Conversations
            </Button>
          )}
        </span>
      </span>
      {opened !== undefined && (
        <div className="source-set-open">
          {opened === 'card' ? <SourceReview source={source} /> : <SourceRoutes source={source} />}
        </div>
      )}
    </li>
  )
}

/** The Sources set up on a connection, newest first; nothing shows for a connection with none. */
export function ConnectionSources({ server }: { readonly server: ServerView }) {
  const sources = (useQuery(sourcesQuery).data?.sources ?? []).filter(
    (source) => source.connectionId === server.connectionId,
  )
  if (sources.length === 0) return null
  return (
    <section className="server-part" aria-label="Sources">
      <h3 className="server-part-title">Sources</h3>
      <p className="server-note">
        A Source carries your own messages from {server.label} into goblin as your turns, and goblin’s answers back.
      </p>
      <ul className="event-sets">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} />
        ))}
      </ul>
    </section>
  )
}
