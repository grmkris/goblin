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

/** Work stays scoped to this channel; a source connection alone says nothing about where its messages go. */
function useChannelWork({ topic }: { readonly topic: TopicView }) {
  const routines = useQuery(routinesQuery)
  const sources = useQuery(sourcesQuery)
  const routes = useQueries({ queries: (sources.data?.sources ?? []).map((source) => sourceRoutesQuery(source.id)) })
  const conversations = useConversations()
  const activity = useActivities()
  const topics = useTopics()
  const personas = usePersonas()
  const threads = conversations.filter(
    (view) =>
      view.id !== topic.conversation &&
      view.closedAt === undefined &&
      channelOf(view.id, conversations, topics) === topic.conversation,
  )
  const waiting = conversations.filter(
    (view) => (view.attention?.length ?? 0) > 0 && channelOf(view.id, conversations, topics) === topic.conversation,
  )
  const scheduled = (routines.data?.routines ?? []).filter((routine) => routine.topic === topic.id)
  const connected = routes.flatMap((read) =>
    read.data === undefined
      ? []
      : read.data.routes
          .filter(({ route }) => 'topic' in route && route.topic === topic.id)
          .map((route) => ({ source: read.data.source, route })),
  )
  const error = routines.error ?? sources.error ?? routes.find((read) => read.error !== null)?.error
  const loading = routines.isPending || sources.isPending || routes.some((read) => read.isPending)
  return {
    routines,
    sources,
    routes,
    activity,
    topics,
    personas,
    threads,
    waiting,
    scheduled,
    connected,
    error,
    loading,
  }
}

export function ChannelWork({ topic }: { readonly topic: TopicView }) {
  const work = useChannelWork({ topic })
  const { routines, sources, routes, error, scheduled } = work
  return (
    <div className="channel-info-sections">
      {error != null && (
        <p role="alert">
          {messageOf(error, 'read channel work')}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              routines.refetch().catch(reportUnexpected)
              sources.refetch().catch(reportUnexpected)
              routes.forEach((read) => {
                read.refetch().catch(reportUnexpected)
              })
            }}
          >
            Try again
          </Button>
        </p>
      )}
      <WorkChats work={work} />
      <section className="channel-info-section">
        <h2>Routines</h2>
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
      <WorkRoutes work={work} />
    </div>
  )
}

function WorkChats({ work }: { readonly work: ReturnType<typeof useChannelWork> }) {
  const { waiting, threads, activity } = work
  const open = useOpenChat()
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
function WorkRoutes({ work }: { readonly work: ReturnType<typeof useChannelWork> }) {
  const { connected, topics, personas, loading, error } = work
  return (
    <section className="channel-info-section">
      <h2>Connected conversations</h2>
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
      {!loading && error == null && connected.length === 0 && (
        <p className="channel-info-empty">No external conversations route here.</p>
      )}
      {loading && <p role="status">Loading channel work…</p>}
    </section>
  )
}
