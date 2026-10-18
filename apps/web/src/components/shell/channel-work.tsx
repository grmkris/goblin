import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TopicView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { routinesQuery } from '../../routines/queries.ts'
import { sourceRoutesQuery, sourcesQuery } from '../../sources/queries.ts'
import { conversationName, routeWords } from '../../lib/source-routes.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { channelOf } from '../../lib/topics.ts'
import { useActivities, useConversations, usePersonas, useTopics } from '../../lib/workspace/hooks.ts'
import { useOpenChat } from './panel.tsx'

/** Work stays scoped to this channel; each section reads its own data, so one failing read leaves the others. */
export function ChannelWork({ topic }: { readonly topic: TopicView }) {
  return (
    <div className="channel-info-sections">
      <WorkChats topic={topic} />
      <WorkRoutines topic={topic} />
      <WorkRoutes topic={topic} />
    </div>
  )
}

/** A section's failed read, with the way to read it again. */
function Failed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <p role="alert">
      {messageOf(error, 'read channel work')}{' '}
      <Button variant="ghost" onClick={onRetry}>
        Try again
      </Button>
    </p>
  )
}

/** The channel's own chats from the workspace feed: the ones waiting on the owner, and its open threads and helpers. */
function WorkChats({ topic }: { readonly topic: TopicView }) {
  const conversations = useConversations()
  const topics = useTopics()
  const activity = useActivities()
  const open = useOpenChat()
  const here = conversations.filter((view) => channelOf(view.id, conversations, topics) === topic.conversation)
  const waiting = here.filter((view) => (view.attention?.length ?? 0) > 0)
  const threads = here.filter((view) => view.id !== topic.conversation && view.closedAt === undefined)
  return (
    <>
      <section className="channel-info-section">
        <h2>Waiting for you</h2>
        {waiting.length === 0 ? (
          <p className="channel-info-empty">Nothing waiting for your decision.</p>
        ) : (
          waiting.map((chat) => (
            <button className="channel-info-row" key={chat.id} onClick={() => open(chat.id)}>
              <span>{chat.title ?? 'Conversation'}</span>
              <small>{chat.attention?.length} to review</small>
            </button>
          ))
        )}
      </section>
      <section className="channel-info-section">
        <h2>Threads & helpers</h2>
        {threads.length === 0 ? (
          <p className="channel-info-empty">Reply in a thread to explore a question separately.</p>
        ) : (
          threads.map((chat) => (
            <button className="channel-info-row" key={chat.id} onClick={() => open(chat.id)}>
              <span>{chat.title ?? (chat.kind === 'subagent' ? 'Helper' : 'Thread')}</span>
              <small>
                {activity[chat.id]?.state === 'working' ? 'Working' : chat.kind === 'subagent' ? 'Helper' : 'Thread'}
              </small>
            </button>
          ))
        )}
      </section>
    </>
  )
}

function WorkRoutines({ topic }: { readonly topic: TopicView }) {
  const routines = useQuery(routinesQuery)
  const scheduled = (routines.data?.routines ?? []).filter((routine) => routine.topic === topic.id)
  return (
    <section className="channel-info-section">
      <h2>Routines</h2>
      {routines.error !== null && (
        <Failed
          error={routines.error}
          onRetry={() => {
            routines.refetch().catch(reportUnexpected)
          }}
        />
      )}
      {scheduled.map((routine) => (
        <Link className="channel-info-row" key={routine.id} to="/work">
          <span>{routine.definition.title}</span>
          <small>{routine.state === 'proposed' ? 'Awaiting approval' : routine.state}</small>
        </Link>
      ))}
      {routines.isSuccess && scheduled.length === 0 && (
        <p className="channel-info-empty">
          No routines in this channel. Ask goblin to suggest a reminder or recurring task.
        </p>
      )}
    </section>
  )
}

/** Source routes into this channel; a source connection alone says nothing about where its messages go. */
function WorkRoutes({ topic }: { readonly topic: TopicView }) {
  const sources = useQuery(sourcesQuery)
  const routes = useQueries({ queries: (sources.data?.sources ?? []).map((source) => sourceRoutesQuery(source.id)) })
  const topics = useTopics()
  const personas = usePersonas()
  const connected = routes.flatMap((read) =>
    read.data === undefined
      ? []
      : read.data.routes
          .filter(({ route }) => 'topic' in route && route.topic === topic.id)
          .map((route) => ({ source: read.data.source, route })),
  )
  const error = sources.error ?? routes.find((read) => read.error !== null)?.error ?? null
  const loading = sources.isPending || routes.some((read) => read.isPending)
  const retry = () => {
    sources.refetch().catch(reportUnexpected)
    for (const read of routes) read.refetch().catch(reportUnexpected)
  }
  return (
    <section className="channel-info-section">
      <h2>Connected conversations</h2>
      {error !== null && <Failed error={error} onRetry={retry} />}
      {connected.map(({ source, route }) => (
        <div className="channel-info-detail-row" key={`${source.id}:${route.key}`}>
          <b>{conversationName(route)}</b>
          <p>{routeWords(route.route, topics, personas)}</p>
          <small>
            {source.label}: {source.state}.{' '}
            {route.route.to === 'listen'
              ? 'No replies sent.'
              : source.setup.reply === undefined
                ? 'Replies stay in goblin.'
                : 'Replies sent back through this connection.'}
          </small>
          <Link className="channel-info-link" to="/work">
            Manage routing
          </Link>
        </div>
      ))}
      {!loading && error === null && connected.length === 0 && (
        <p className="channel-info-empty">No external conversations route here.</p>
      )}
      {loading && <p role="status">Loading channel work…</p>}
    </section>
  )
}
