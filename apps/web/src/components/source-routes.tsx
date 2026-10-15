// A Source's conversations (ADR 0066): a row per conversation key with what it holds and where its messages go, saved
// as soon as it is picked. The select is the Telegram chats' (PlaceSelects): a Topic answered by goblin or a Persona,
// notes in a Topic, Hold or Ignore.
import { useMutation, useQuery } from '@tanstack/react-query'
import type { SourceRouteView, SourceView } from '@goblin/contracts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { choiceOfRoute, conversationName, routeOfChoice, sourceRouteOptions } from '../lib/source-routes.ts'
import { type RouteChoice, waitingWords } from '../lib/telegram-chats.ts'
import { routeSourceMutation, sourceRoutesQuery } from '../sources/queries.ts'
import { StatusLabel } from './status-label.tsx'
import { PlaceSelects, type RoutePlaces, useRoutePlaces } from './telegram-chats.tsx'

/** Where a Source's conversation goes: the place select over the Topics, and who answers when it is answered. */
export function SourceRouteSelect({
  name,
  choice,
  places,
  onChoose,
}: {
  readonly name: string
  readonly choice: RouteChoice
  readonly places: RoutePlaces
  readonly onChoose: (choice: RouteChoice) => void
}) {
  return (
    <PlaceSelects
      name={name}
      choice={choice}
      groups={sourceRouteOptions(places.topics, choice.place)}
      personas={places.personas}
      onChoose={onChoose}
    />
  )
}

/** Who set a conversation's route last, quietly; none when the owner did. */
const setBy = (view: SourceRouteView): string | undefined =>
  view.updatedBy === 'agent' ? 'Set by goblin' : view.updatedBy === 'default' ? 'Where new conversations go' : undefined

/**
 * One conversation: its key in words, what it holds while it waits, and its route, saved as soon as it is picked. The
 * pick shows while it saves; a refusal puts the route back and says why under the key.
 */
function RouteRow({
  source,
  view,
  places,
}: {
  readonly source: SourceView
  readonly view: SourceRouteView
  readonly places: RoutePlaces
}) {
  const routing = useMutation(routeSourceMutation)
  const choice = choiceOfRoute(routing.isPending ? routing.variables.route : view.route)
  const name = conversationName(view)
  const waiting = view.route.to === 'held' ? waitingWords(view.held) : undefined
  const meta = setBy(view)
  return (
    <li className="telegram-chat" aria-busy={routing.isPending}>
      <span className="telegram-chat-text">
        <span className="telegram-chat-title">
          <span className="telegram-chat-name">{name}</span>
          {waiting !== undefined && <StatusLabel label={{ text: waiting, tone: 'attention' }} />}
        </span>
        {meta !== undefined && <span className="telegram-chat-meta">{meta}</span>}
        {routing.error !== null && (
          <span className="telegram-chat-meta" role="alert">
            {messageOf(routing.error, `change where “${name}” goes`)}
          </span>
        )}
      </span>
      <SourceRouteSelect
        name={name}
        choice={choice}
        places={places}
        onChoose={(next) => {
          const route = routeOfChoice(next)
          if (route !== undefined) routing.mutate({ id: source.id, key: view.key, route })
        }}
      />
    </li>
  )
}

/** A Source's route table: every conversation it has seen, newest first, each with where it goes. */
export function SourceRoutes({ source }: { readonly source: SourceView }) {
  const read = useQuery(sourceRoutesQuery(source.id))
  const places = useRoutePlaces()
  const routes = read.data?.routes
  if (read.error !== null)
    return (
      <QueryError error={read.error} action={`read where ${source.title} goes`} onRetry={() => void read.refetch()} />
    )
  if (routes === undefined)
    return (
      <p className="server-note" role="status">
        Reading its conversations…
      </p>
    )
  if (routes.length === 0) return <p className="server-note">No conversation has written yet.</p>
  return (
    <ul className="telegram-chat-list" aria-label={`Conversations of ${source.title}`}>
      {routes.map((view) => (
        <RouteRow key={view.key} source={source} view={view} places={places} />
      ))}
    </ul>
  )
}
