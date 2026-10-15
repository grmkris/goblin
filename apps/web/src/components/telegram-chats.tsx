// The Telegram channel's chats (ADR 0055): a row per chat and forum topic, the topics nested under their chat, each
// with where its messages go and who answers there; the default for chats goblin has not seen; and, while the grant
// reaches only the private chat, the way to let goblin see the owner's groups.
import { Fragment, useId } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { NewChatsDefault, PersonaView, TelegramChat, TopicView } from '@goblin/contracts'
import { NativeSelect, NativeSelectOption } from '@goblin/ui'
import { ExternalLinkIcon } from 'lucide-react'
import { channelChatsQuery, channelSettingsMutation, routeChannelMutation } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import {
  NEW_CHATS,
  type Option,
  type OptionGroup,
  type RouteChoice,
  answers,
  chatGroups,
  chatKey,
  chatMeta,
  chatStatus,
  choiceOf,
  choiceOfPick,
  newChatsOf,
  pickOf,
  responderOptions,
  routeOptions,
  widenLink,
} from '../lib/telegram-chats.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { StatusLabel } from './status-label.tsx'

/** Where a route can go: every Topic and Persona (the selects list the live ones, an archived one only while chosen). */
export type RoutePlaces = { readonly topics: readonly TopicView[]; readonly personas: readonly PersonaView[] }

export const useRoutePlaces = (): RoutePlaces => ({ topics: useTopics(), personas: usePersonas() })

const option = ({ value, text }: Option) => (
  <NativeSelectOption key={value} value={value}>
    {text}
  </NativeSelectOption>
)

/**
 * Where something's messages go (`groups`, the place select's options) and beside it, when they are answered, who
 * answers: goblin or a Persona. `name` is what the selects are about, for their labels. Telegram chats and a Source's
 * conversations (components/source-routes.tsx) both choose with it.
 */
export function PlaceSelects({
  name,
  choice,
  groups,
  personas,
  onChoose,
}: {
  readonly name: string
  readonly choice: RouteChoice
  readonly groups: readonly OptionGroup[]
  readonly personas: readonly PersonaView[]
  readonly onChoose: (choice: RouteChoice) => void
}) {
  return (
    <span className="telegram-route">
      <NativeSelect
        size="sm"
        aria-label={`Where “${name}” goes`}
        value={choice.place}
        onChange={(event) => onChoose({ ...choice, place: event.target.value })}
      >
        {choice.place === '' && (
          <NativeSelectOption value="" disabled>
            Choose where it goes
          </NativeSelectOption>
        )}
        {groups.map((group, index) => (
          // The groups are fixed in number and order, so their place names them.
          <Fragment key={group.label ?? `plain-${String(index)}`}>
            {group.label === undefined ? (
              group.options.map(option)
            ) : (
              <optgroup label={group.label}>{group.options.map(option)}</optgroup>
            )}
          </Fragment>
        ))}
      </NativeSelect>
      {answers(choice) && (
        <NativeSelect
          size="sm"
          aria-label={`Who answers in “${name}”`}
          value={choice.responder}
          onChange={(event) => onChoose({ ...choice, responder: event.target.value })}
        >
          {responderOptions(personas, choice.responder).map(option)}
        </NativeSelect>
      )}
    </span>
  )
}

/**
 * Where a chat's messages go, in the event picker's compact select (a Topic to answer in, one to listen in, Ignore, or
 * for a forum topic Same as the chat), and beside it, when its messages are answered, who answers: goblin or a Persona.
 */
export function RouteSelect({
  chat,
  choice,
  places,
  onChoose,
}: {
  readonly chat: TelegramChat
  readonly choice: RouteChoice
  readonly places: RoutePlaces
  readonly onChoose: (choice: RouteChoice) => void
}) {
  return (
    <PlaceSelects
      name={chat.title}
      choice={choice}
      groups={routeOptions(chat, places.topics, choice.place)}
      personas={places.personas}
      onChoose={onChoose}
    />
  )
}

/**
 * One chat or forum topic: its title, a state only when it is not the usual one, its kind, and its route, saved as soon
 * as it is picked. The pick shows while it saves; a refusal puts the route back and says why under the title.
 */
function ChatRow({ chat, places }: { readonly chat: TelegramChat; readonly places: RoutePlaces }) {
  const route = useMutation(routeChannelMutation)
  const saving = route.isPending ? route.variables : undefined
  const choice = saving === undefined ? choiceOf(chat) : choiceOfPick(saving, places.topics)
  // A pick ends the wait at once; a paused or left chat stays so whatever its route.
  const status = saving === undefined || chat.status !== 'pending' ? chatStatus(chat) : undefined
  const choose = (next: RouteChoice) => {
    const pick = pickOf(chat, next, places.topics)
    if (pick !== undefined) route.mutate(pick)
  }
  return (
    <div className="telegram-chat" aria-busy={route.isPending}>
      <span className="telegram-chat-text">
        <span className="telegram-chat-title">
          <span className="telegram-chat-name">{chat.title}</span>
          {status !== undefined && <StatusLabel label={status} />}
        </span>
        <span className="telegram-chat-meta">{chatMeta(chat)}</span>
        {route.error !== null && (
          <span className="telegram-chat-meta" role="alert">
            {messageOf(route.error, `change where “${chat.title}” goes`)}
          </span>
        )}
      </span>
      <RouteSelect chat={chat} choice={choice} places={places} onChoose={choose} />
    </div>
  )
}

/** The chats, the private chat first, each group's forum topics nested under it. */
function ChatList({ chats, places }: { readonly chats: readonly TelegramChat[]; readonly places: RoutePlaces }) {
  return (
    <ul className="telegram-chat-list" aria-label="Telegram chats">
      {chatGroups(chats).map((group) => (
        <li key={group.chat} className="telegram-chat-group">
          {group.row === undefined ? (
            <p className="telegram-chat-heading">{group.title}</p>
          ) : (
            <ChatRow chat={group.row} places={places} />
          )}
          {group.topics.length > 0 && (
            <ul className="telegram-topics" aria-label={`Topics in “${group.title}”`}>
              {group.topics.map((topic) => (
                <li key={chatKey(topic)}>
                  <ChatRow chat={topic} places={places} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

/** What goblin does with a chat it has not seen: ask the owner, give it a Topic, or send it to #Personal. */
function NewChats({ value }: { readonly value: NewChatsDefault }) {
  const id = useId()
  const setting = useMutation(channelSettingsMutation)
  return (
    <div className="telegram-setting" aria-busy={setting.isPending}>
      <span className="grant-text">
        <label htmlFor={id} className="grant-name">
          New chats
        </label>
        <span className="telegram-chat-meta" role={setting.error === null ? undefined : 'alert'}>
          {setting.error === null
            ? NEW_CHATS[value].about
            : messageOf(setting.error, 'change what goblin does with new chats')}
        </span>
      </span>
      <NativeSelect
        id={id}
        size="sm"
        value={value}
        onChange={(event) => {
          const next = newChatsOf(event.target.value)
          if (next !== undefined) setting.mutate(next)
        }}
      >
        {(['ask', 'topic', 'personal'] as const).map((each) => option({ value: each, text: NEW_CHATS[each].text }))}
      </NativeSelect>
    </div>
  )
}

/** While the grant reaches only the private chat: so, and the way to widen it on mysi's consent screen. */
function ReachNote({ widenUrl }: { readonly widenUrl: string | undefined }) {
  const link = widenLink(widenUrl)
  return (
    <p className="telegram-reach">
      goblin sees only your private chat.
      {link !== undefined && (
        <>
          {' '}
          <a className="cause-link telegram-widen" href={link} target="_blank" rel="noopener noreferrer">
            Let goblin see your groups
            <ExternalLinkIcon aria-hidden />
          </a>
        </>
      )}
    </p>
  )
}

/**
 * The chats of the Telegram channel on `connectionId` (ADR 0055): the default for new chats, how far goblin sees, and
 * every chat and topic with its route. Rendered only while this connection carries the channel.
 */
export function TelegramChats({ connectionId }: { readonly connectionId: string }) {
  const read = useQuery(channelChatsQuery(connectionId))
  const places = useRoutePlaces()
  const list = read.data
  return (
    <div className="telegram-chats">
      {read.error !== null ? (
        <QueryError error={read.error} action="read your Telegram chats" onRetry={() => void read.refetch()} />
      ) : list === undefined ? (
        <p className="server-note" role="status">
          Reading your chats…
        </p>
      ) : (
        <>
          <NewChats value={list.newChats} />
          {list.reach === 'dm' && <ReachNote widenUrl={list.widenUrl} />}
          {!list.synced && (
            <p className="server-note">
              Telegram’s chat list could not be read just now, so these are the chats goblin knows.
            </p>
          )}
          <ChatList chats={list.chats} places={places} />
        </>
      )}
    </div>
  )
}
