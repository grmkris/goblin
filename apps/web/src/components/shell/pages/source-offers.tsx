// Activity's part of Sources (ADR 0066): each conversation a Source holds until the owner says where it goes (with the
// route select, Not now and Set up, which delivers what it held), and each Source paused for the owner's review because
// its connection's address or the access it was confirmed with changed, or its subscription ended.
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { SourceView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { InboxIcon, ShieldAlertIcon } from 'lucide-react'
import { notNowList } from '../../../lib/not-now.ts'
import {
  type WaitingConversation,
  keyWords,
  routeOfChoice,
  sourcesToReview,
  waitingChoice,
  waitingConversations,
  waitingKey,
} from '../../../lib/source-routes.ts'
import { type RouteChoice, waitingWords } from '../../../lib/telegram-chats.ts'
import { changeSourceMutation, routeSourceMutation, sourcesQuery } from '../../../sources/queries.ts'
import { PageSection } from '../../page-section.tsx'
import { connectionAnchor } from '../../server-card.tsx'
import { sourceRefusal } from '../../source-review.tsx'
import { SourceRouteSelect } from '../../source-routes.tsx'
import { type RoutePlaces, useRoutePlaces } from '../../telegram-chats.tsx'
import { RowContents } from './chat-link.tsx'
import { OfferPick } from './offer-pick.tsx'

/** The waiting conversations this browser was told Not now; they keep waiting on their Source's card. */
const notNow = notNowList('goblin:source-not-now')

/** A conversation a Source holds for the owner: where its messages go (#Personal to start with), Not now or Set up. */
function WaitingRow({
  item,
  places,
  onNotNow,
}: {
  readonly item: WaitingConversation
  readonly places: RoutePlaces
  readonly onNotNow: () => void
}) {
  const routing = useMutation(routeSourceMutation)
  const [choice, setChoice] = useState<RouteChoice>(waitingChoice)
  const route = routeOfChoice(choice)
  const name = keyWords(item.waiting.values)
  // expected: a refusal shows why in place of the row's line, and the row stays
  const error = routing.error === null ? '' : sourceRefusal(routing.error, `set up “${name}”`)
  return (
    <li className="list-row telegram-offer" data-static>
      <RowContents
        mark={<InboxIcon aria-hidden />}
        title={`New conversation “${name}” on ${item.source.title}`}
        meta={error === '' ? (waitingWords(item.waiting.held) ?? 'Choose where its messages go') : error}
      />
      <OfferPick
        select={
          <SourceRouteSelect
            name={name}
            choice={choice}
            places={places}
            onChoose={(next) => {
              routing.reset()
              setChoice(next)
            }}
          />
        }
        pending={routing.isPending}
        ready={route !== undefined && route.to !== 'held'}
        onNotNow={onNotNow}
        onSetUp={() => {
          if (route !== undefined) routing.mutate({ id: item.source.id, key: item.waiting.key, route })
        }}
      />
    </li>
  )
}

/** A Source paused for the owner's review: why, Resume (bound again to its connection as it is now), and its card. */
function ReviewRow({ source }: { readonly source: SourceView }) {
  const changing = useMutation(changeSourceMutation)
  // expected: a refusal shows why in place of the row's line, and the row stays
  const error = changing.error === null ? '' : sourceRefusal(changing.error, `resume ${source.title}`)
  return (
    <li className="list-row" data-static>
      <RowContents
        mark={<ShieldAlertIcon aria-hidden />}
        title={`Review ${source.title}`}
        meta={error === '' ? (source.health ?? `What ${source.label} reaches changed since you confirmed it.`) : error}
        end={
          <span className="row-actions">
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link to="/connections" hash={connectionAnchor(source.connectionId)} />}
            >
              Open
            </Button>
            <Button
              variant="outline"
              size="sm"
              pending={changing.isPending}
              onClick={() => changing.mutate({ action: 'resume', id: source.id })}
            >
              Resume
            </Button>
          </span>
        }
      />
    </li>
  )
}

/**
 * What the owner's Sources wait on them for: conversations held for a route, less the ones this browser was told Not
 * now, and Sources paused for review. `count` is how many things wait.
 */
export function useSourceOffers() {
  const sources = useQuery(sourcesQuery).data?.sources ?? []
  const [hidden, setHidden] = useState(notNow.read)
  const all = waitingConversations(sources)
  const waiting = all.filter((item) => !hidden.includes(waitingKey(item)))
  const review = sourcesToReview(sources)
  const dismiss = (item: WaitingConversation) => setHidden(notNow.remember(waitingKey(item), all.map(waitingKey)))
  return { waiting, review, dismiss, count: waiting.length + review.length }
}

/** Activity's Sources section: conversations waiting for a route, then Sources to review. */
export function SourceOffers({ offers }: { readonly offers: ReturnType<typeof useSourceOffers> }) {
  const places = useRoutePlaces()
  return (
    <PageSection id="source-offers" title="Sources" count={offers.count}>
      <ul className="list-rows">
        {offers.review.map((source) => (
          <ReviewRow key={source.id} source={source} />
        ))}
        {offers.waiting.map((item) => (
          <WaitingRow key={waitingKey(item)} item={item} places={places} onNotNow={() => offers.dismiss(item)} />
        ))}
      </ul>
    </PageSection>
  )
}
