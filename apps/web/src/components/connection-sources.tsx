// A connection's Sources (ADR 0066), on its card under its Events: each Source set up on it, with its card (its facts,
// Confirm while proposed, Pause, Resume and Remove) and its conversations, and for each event the server suggests a
// Source on, Set up, which proposes it for the owner to review here.
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { EventStream, ServerView, SourceView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { eventTitle } from '../lib/events.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { sourceStatus } from '../lib/source-routes.ts'
import { proposalOf } from '../lib/source-setup.ts'
import { eventsQuery } from '../mcp/queries.ts'
import { proposeSourceMutation, sourcesQuery } from '../sources/queries.ts'
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

/** An event the server suggests a Source on, with none set up yet: Set up proposes it, for review on its row. */
function SuggestedRow({ server, stream }: { readonly server: ServerView; readonly stream: EventStream }) {
  const proposing = useMutation(proposeSourceMutation)
  // One operation for this offer, so a Set up sent again finds the proposal it made.
  const [operationId] = useState(() => crypto.randomUUID())
  const proposal = proposalOf(stream, server.connectionId, server.label, operationId)
  return (
    <li className="event-set">
      <span className="event-set-text">
        <span className="event-set-title">{eventTitle(stream)}</span>
        <span className="event-pick-about">
          {proposing.error === null
            ? `${server.label} suggests carrying your messages here as a Source. You review it before anything runs.`
            : messageOf(proposing.error, 'propose it')}
        </span>
      </span>
      <span className="event-set-side">
        <Button
          type="button"
          size="xs"
          variant="outline"
          pending={proposing.isPending}
          disabled={proposal === undefined}
          onClick={() => {
            if (proposal !== undefined) proposing.mutate(proposal)
          }}
        >
          Set up
        </Button>
      </span>
    </li>
  )
}

/**
 * The Sources of a connection that sends events: those set up on it, then the events its server suggests a Source on
 * that have none yet (one refused may be set up again). Nothing shows for a connection with neither.
 */
export function ConnectionSources({ server }: { readonly server: ServerView }) {
  const sources = (useQuery(sourcesQuery).data?.sources ?? []).filter(
    (source) => source.connectionId === server.connectionId,
  )
  const streams = useQuery(eventsQuery(server.events === undefined ? undefined : server.connectionId)).data ?? []
  const taken = new Set(sources.filter((source) => source.state !== 'refused').map((source) => source.setup.wake.event))
  const suggested = streams.filter(
    (stream) => stream.source !== undefined && stream.subscribable && !taken.has(stream.name),
  )
  if (sources.length === 0 && suggested.length === 0) return null
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
        {suggested.map((stream) => (
          <SuggestedRow key={stream.name} server={server} stream={stream} />
        ))}
      </ul>
    </section>
  )
}
