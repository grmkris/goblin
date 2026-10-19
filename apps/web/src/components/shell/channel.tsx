import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Navigate, useNavigate } from '@tanstack/react-router'
import type { ConversationView, TopicView } from '@goblin/contracts'
import { Button, TopBar, TopBarTitle } from '@goblin/ui'
import { HashIcon, InfoIcon } from 'lucide-react'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { rememberChannel } from '../../lib/last-channel.ts'
import { type PanelSearch, panelItems } from '../../lib/panel.ts'
import { channelOf, isArchived, isChannel, topicOfChannel } from '../../lib/topics.ts'
import { useActivity, useConversation, useConversations, useTopics } from '../../lib/workspace/hooks.ts'
import { ArchivedBanner } from './channel-menu.tsx'
import { ChatView } from './chat-view.tsx'
import { PanelProvider } from './panel.tsx'
import { NavigationButton } from './shell.tsx'
import { ThreadPanel } from './thread-panel.tsx'
import { ChannelInfo } from './channel-info.tsx'

/** The channel's name as its bar shows it: `#` and the Topic's name, with a pulse while its agent works. */
function ChannelName({ name, working }: { readonly name: string; readonly working: boolean }) {
  return (
    <span className="channel-title">
      <HashIcon aria-hidden />
      <span className="truncate">{name}</span>
      {working && <span className="thread-busy" aria-label="Working" />}
    </span>
  )
}

/** A channel's bar: on a phone the navigation's button, then `#` and the Topic's name, and its Info button. */
function ChannelHeader({
  view,
  topic,
  onInfo,
  infoTrigger,
  infoOpen,
}: {
  readonly view: ConversationView
  readonly topic: TopicView | undefined
  readonly infoTrigger: RefObject<HTMLButtonElement | null>
  readonly infoOpen: boolean
  readonly onInfo: () => void
}) {
  const working = useActivity(view.id)?.state === 'working'
  return (
    <TopBar floating data-app-cover>
      <NavigationButton />
      <TopBarTitle>
        <ChannelName name={topic?.name ?? view.title ?? 'Personal'} working={working} />
      </TopBarTitle>
      <Button
        variant="ghost"
        className="size-11 shrink-0 me-1"
        ref={infoTrigger}
        aria-expanded={infoOpen}
        aria-haspopup="dialog"
        aria-label={`Info for #${topic?.name ?? view.title ?? 'Personal'}`}
        onClick={onInfo}
      >
        <InfoIcon />
      </Button>
    </TopBar>
  )
}

/** The channel and, when its search opens one, the thread panel beside it (over it on a phone). */
function ChannelLayout({ view, search }: { readonly view: ConversationView; readonly search: PanelSearch }) {
  const conversations = useConversations()
  const topic = topicOfChannel(view.id, useTopics())
  const items = useMemo(() => panelItems(search, view.id, conversations), [search, view.id, conversations])
  const [heads, setHeads] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState('')
  const infoOpen = search.info === true
  const navigate = useNavigate()
  const infoTrigger = useRef<HTMLButtonElement>(null)
  // The info panel's container is the element itself, not a ref: a panel open from the first render (a link with
  // `info=true`) mounts its portal in that commit, before a ref is attached, and Base UI waits for a `null` container.
  const [layout, setLayout] = useState<HTMLDivElement | null>(null)
  const setInfoOpen = (info: boolean) => {
    navigate({ to: '/c/$chatId', params: { chatId: view.id }, search: { ...search, info } }).catch(reportUnexpected)
  }
  useEffect(() => rememberChannel(view.id), [view.id])
  const open = items.length > 0
  const archived = topic !== undefined && isArchived(topic)
  return (
    <PanelProvider channel={view.id} items={items}>
      <div ref={setLayout} className="channel-layout" data-panel={open || undefined} data-info={infoOpen || undefined}>
        <div className="channel-column">
          <ChatView
            key={view.id}
            view={view}
            place="channel"
            active={!open && !infoOpen}
            header={
              <ChannelHeader
                view={view}
                topic={topic}
                onInfo={() => setInfoOpen(true)}
                infoTrigger={infoTrigger}
                infoOpen={infoOpen}
              />
            }
            notices={failure === '' ? [] : [failure]}
            {...(archived && { banner: <ArchivedBanner topic={topic} onFailure={setFailure} /> })}
            onHeads={setHeads}
          />
        </div>
        {open && <ThreadPanel heads={heads} />}
        {topic !== undefined && (
          <ChannelInfo
            topic={topic}
            open={infoOpen}
            onOpenChange={setInfoOpen}
            trigger={infoTrigger}
            container={layout}
            failure={failure}
            onFailure={setFailure}
          />
        )}
      </div>
    </PanelProvider>
  )
}

/**
 * `/c/<id>`: a Topic's channel, with the thread panel its search names. A thread's or subagent's id opens its channel
 * with the panel showing it, so every old link to a chat still leads there.
 */
export function ChannelPage({ chat, search }: { readonly chat: string; readonly search: PanelSearch }) {
  const conversations = useConversations()
  const topics = useTopics()
  const view = useConversation(chat)
  if (view !== undefined && !isChannel(view)) {
    const channel = channelOf(chat, conversations, topics)
    return <Navigate to="/c/$chatId" params={{ chatId: channel }} search={{ thread: Number(chat) }} replace />
  }
  if (view === undefined)
    return (
      <div className="channel-layout" aria-busy>
        <div className="channel-column">
          <section className="chat-view" data-place="channel">
            <TopBar floating>
              <NavigationButton />
            </TopBar>
          </section>
        </div>
      </div>
    )
  return <ChannelLayout view={view} search={search} />
}
