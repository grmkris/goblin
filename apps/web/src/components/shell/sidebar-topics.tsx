// The sidebar's Topics (ADR 0078): each channel with its live threads, the archived folded, Add topic and All threads;
// in the strip, one `#` that lists them beside it. Under them, each key's rooms (ADR 0108), folded.
import { use, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ConversationView, TopicView } from '@goblin/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@goblin/ui'
import { ChevronDownIcon, ChevronRightIcon, HashIcon, MessagesSquareIcon, PlusIcon } from 'lucide-react'
import { isUnread, threadTitle } from '../../lib/threads.ts'
import { type RoomGroup, channelOf, channels, matchingRooms, roomGroups, topicThreads } from '../../lib/topics.ts'
import { useActivities, useActivity, useConversation, useConversations, useTopics } from '../../lib/workspace/hooks.ts'
import { Count, EXACT, Here, Section, Strip, Tip, useCurrent } from './sidebar-parts.tsx'
import { useFolded, useRecentThreads } from './sidebar-state.ts'
import { TopicDialog } from './topic-dialog.tsx'

/** A Topic's channel: `#` and its name, bold with a dot while it has replies the owner has not read. */
function ChannelRow({ topic }: { readonly topic: TopicView }) {
  const view = useConversation(topic.conversation)
  const unread = view !== undefined && isUnread(view)
  const working = useActivity(topic.conversation) !== undefined
  const current = useCurrent(`topic:${topic.conversation}`)
  return (
    <li>
      <Link
        activeOptions={EXACT}
        to="/c/$chatId"
        params={{ chatId: topic.conversation }}
        className="sidebar-row"
        aria-current={current}
        data-unread={unread || undefined}
      >
        <HashIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">{topic.name}</span>
        {working && <span className="sidebar-row-busy" aria-label="Working" />}
        {unread && !working && <span className="sidebar-row-unread" aria-label="Unread replies" />}
      </Link>
    </li>
  )
}

/** A thread under its channel: its name, bold with a dot while unread, a pulse while it works; opens in the panel. */
function ThreadRow({ view, channel }: { readonly view: ConversationView; readonly channel: string }) {
  const unread = isUnread(view)
  const working = useActivity(view.id) !== undefined
  const current = useCurrent(`thread:${view.id}`)
  return (
    <li>
      <Link
        activeOptions={EXACT}
        to="/c/$chatId"
        params={{ chatId: channel }}
        search={{ thread: Number(view.id) }}
        className="sidebar-row sidebar-thread"
        aria-current={current}
        data-unread={unread || undefined}
      >
        <MessagesSquareIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">{threadTitle(view)}</span>
        {working && <span className="sidebar-row-busy" aria-label="Working" />}
        {unread && !working && <span className="sidebar-row-unread" aria-label="Unread replies" />}
      </Link>
    </li>
  )
}

/** A channel with, one flat level under it, its threads at work, unread, recently opened or showing now. */
function ChannelWithThreads({ topic, recent }: { readonly topic: TopicView; readonly recent: ReadonlySet<string> }) {
  const conversations = useConversations()
  const topics = useTopics()
  const activity = useActivities()
  const here = use(Here)
  const showing = here?.row.startsWith('thread:') === true ? here.row.slice('thread:'.length) : undefined
  const shown = showing === undefined ? recent : new Set([...recent, showing])
  const threads = topicThreads(topic.conversation, conversations, topics, activity, shown)
  return (
    <>
      <ChannelRow topic={topic} />
      {threads.map((view) => (
        <ThreadRow key={view.id} view={view} channel={topic.conversation} />
      ))}
    </>
  )
}

/** The archived Topics, folded under one row until asked for. */
function Archived({ topics }: { readonly topics: readonly TopicView[] }) {
  const [open, setOpen] = useState(false)
  if (topics.length === 0) return null
  return (
    <>
      <li>
        <button type="button" className="sidebar-row sidebar-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon className="sidebar-row-mark" aria-hidden />
          <span className="sidebar-row-name">Archived ({topics.length})</span>
        </button>
      </li>
      {open && topics.map((topic) => <ChannelRow key={topic.id} topic={topic} />)}
    </>
  )
}

/** "+ Add topic" at the end of the Topics: it opens the new Topic's dialog. */
function AddTopic() {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button type="button" className="sidebar-row" onClick={() => setOpen(true)}>
        <PlusIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">Add topic</span>
      </button>
      {open && <TopicDialog open onOpenChange={setOpen} />}
    </li>
  )
}

/** "All threads" at the end of the Topics, with how many have replies the owner has not read. */
function AllThreads({ unread }: { readonly unread: number }) {
  const current = useCurrent('threads')
  return (
    <li>
      <Link activeOptions={EXACT} to="/threads" className="sidebar-row" aria-current={current}>
        <MessagesSquareIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">All threads</span>
        <Count count={unread} words="unread" />
      </Link>
    </li>
  )
}

/** How many of a key's rooms show when its section opens; Show more adds as many again. */
const ROOMS_SHOWN = 20

/** The channel of the page, when it shows a channel or a thread of one. */
function useShowingChannel(): string | undefined {
  const here = use(Here)
  const conversations = useConversations()
  const topics = useTopics()
  if (here === undefined) return undefined
  if (here.row.startsWith('topic:')) return here.row.slice('topic:'.length)
  if (here.row.startsWith('thread:')) return channelOf(here.row.slice('thread:'.length), conversations, topics)
  return undefined
}

/** A key's open rooms: a filter field, then the rooms whose name holds it, a few at a time. */
function RoomList({ group, recent }: { readonly group: RoomGroup; readonly recent: ReadonlySet<string> }) {
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(ROOMS_SHOWN)
  const matching = matchingRooms(group.rooms, filter)
  return (
    <>
      <li>
        <input
          type="search"
          className="sidebar-filter"
          value={filter}
          placeholder="Filter rooms"
          aria-label={`Filter the rooms of ${group.key}`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </li>
      {matching.length === 0 && <li className="sidebar-rows-note">No rooms match.</li>}
      {matching.slice(0, shown).map((room) => (
        <ChannelWithThreads key={room.id} topic={room} recent={recent} />
      ))}
      {matching.length > shown && (
        <li>
          <button type="button" className="sidebar-row" onClick={() => setShown((count) => count + ROOMS_SHOWN)}>
            <ChevronDownIcon className="sidebar-row-mark" aria-hidden />
            <span className="sidebar-row-name">Show {Math.min(ROOMS_SHOWN, matching.length - shown)} more</span>
          </button>
        </li>
      )}
    </>
  )
}

/**
 * One key's rooms (ADR 0108), a section under the Topics that starts folded (the owner's choice is remembered in this
 * browser): the key's name and how many rooms, with a dot while any has replies the owner has not read. Open, a filter
 * field and the rooms, the latest active first; folded, the room the page shows keeps its row, so the page's place
 * still shows.
 */
function Rooms({ group, recent }: { readonly group: RoomGroup; readonly recent: ReadonlySet<string> }) {
  const [folded, toggle] = useFolded(`rooms:${group.key}`, true)
  const views = useConversations()
  const showing = useShowingChannel()
  const unread = new Set(views.filter(isUnread).map((view) => view.id))
  const anyUnread = group.rooms.some((room) => unread.has(room.conversation))
  const here = group.rooms.find((room) => room.conversation === showing)
  const count = group.rooms.length
  return (
    <section className="sidebar-section" aria-label={`Rooms of ${group.key}`} data-section="rooms">
      <div className="sidebar-section-head">
        <button type="button" className="sidebar-section-toggle" aria-expanded={!folded} onClick={toggle}>
          <ChevronRightIcon aria-hidden />
          <span className="sidebar-rooms-key">{group.key}</span>
          <span className="sidebar-rooms-count">
            · {count} {count === 1 ? 'room' : 'rooms'}
          </span>
          {anyUnread && folded && (
            <>
              <span className="sidebar-row-unread" aria-hidden />
              <span className="sr-only">, unread replies</span>
            </>
          )}
        </button>
      </div>
      <ul className="sidebar-rows">
        {folded ? (
          here !== undefined && <ChannelWithThreads topic={here} recent={recent} />
        ) : (
          <RoomList group={group} recent={recent} />
        )}
      </ul>
    </section>
  )
}

/**
 * The Topics as channels: Personal first, each with its live threads under it, the archived folded, then the rest;
 * under them each key's rooms, the key with the latest activity first.
 */
export function Topics({ unread }: { readonly unread: number }) {
  const recent = useRecentThreads()
  const topics = useTopics()
  const { active, archived } = channels(topics)
  const rooms = roomGroups(topics, useConversations())
  return (
    <>
      <Section id="topics" label="Topics">
        {active.map((topic) => (
          <ChannelWithThreads key={topic.id} topic={topic} recent={recent} />
        ))}
        <Archived topics={archived} />
        <AddTopic />
        <AllThreads unread={unread} />
      </Section>
      {rooms.map((group) => (
        <Rooms key={group.key} group={group} recent={recent} />
      ))}
    </>
  )
}

/**
 * The Topics in the strip: one `#` that opens them in a list beside it, with a dot while any has replies the owner has
 * not read. A click on a row goes there and closes the list.
 */
export function TopicsInStrip({ unread }: { readonly unread: number }) {
  const [open, setOpen] = useState(false)
  const { active } = channels(useTopics())
  const views = useConversations()
  const here = use(Here)
  const anyUnread = active.some((topic) => {
    const view = views.find((each) => each.id === topic.conversation)
    return view !== undefined && isUnread(view)
  })
  const strip = use(Strip)
  const held = strip && here !== undefined && (here.row.startsWith('topic:') || here.row.startsWith('thread:'))
  return (
    <li>
      <Popover open={open} onOpenChange={setOpen}>
        <Tip label="Topics">
          <PopoverTrigger
            render={<button type="button" className="sidebar-row" aria-current={held ? 'true' : undefined} />}
          >
            <HashIcon className="sidebar-row-mark" aria-hidden />
            <span className="sidebar-row-name">Topics</span>
            {anyUnread && <span className="sidebar-row-unread" aria-label="Unread replies" />}
          </PopoverTrigger>
        </Tip>
        <PopoverContent
          side="right"
          align="start"
          size="panel"
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest('a[href]') !== null) setOpen(false)
          }}
        >
          <ul className="strip-topics">
            {active.map((topic) => (
              <li key={topic.id}>
                <Link
                  activeOptions={EXACT}
                  to="/c/$chatId"
                  params={{ chatId: topic.conversation }}
                  className="strip-topic"
                >
                  <HashIcon aria-hidden />
                  <span>{topic.name}</span>
                </Link>
              </li>
            ))}
            <li>
              <Link activeOptions={EXACT} to="/threads" className="strip-topic">
                <MessagesSquareIcon aria-hidden />
                <span>All threads</span>
                {unread > 0 && <span className="strip-topic-count">{unread}</span>}
              </Link>
            </li>
          </ul>
        </PopoverContent>
      </Popover>
    </li>
  )
}
