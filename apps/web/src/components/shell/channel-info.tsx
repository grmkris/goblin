import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TopicView } from '@goblin/contracts'
import {
  Button,
  Dialog,
  DialogPanel,
  DialogTitle,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  useIsMobile,
} from '@goblin/ui'
import { ArrowLeftIcon, XIcon } from 'lucide-react'
import { TopicSetupDrawer } from '../topic-setup.tsx'
import { ChannelDetails } from './channel-details.tsx'
import { ChannelTools } from './channel-tools.tsx'
import { ChannelWork } from './channel-work.tsx'
import { ChannelMenu } from './channel-menu.tsx'
import { ChannelShared } from './channel-shared.tsx'

/** Read-first channel details. The surrounding layout keeps chat and thread composers mounted. */
export function ChannelInfo({
  topic,
  open,
  onOpenChange,
  trigger,
  container,
  failure,
  onFailure,
}: {
  readonly topic: TopicView
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly trigger: RefObject<HTMLButtonElement | null>
  readonly container: HTMLDivElement | null
  readonly failure: string
  readonly onFailure: (message: string) => void
}) {
  const [setupOpen, setSetupOpen] = useState(false)
  const narrow = useIsMobile()
  const wasOpen = useRef(open)
  useEffect(() => {
    const closing = wasOpen.current && !open
    wasOpen.current = open
    if (!closing) return
    // Route navigation reveals the chat after Base UI's dismissal callback. Restore focus after that commit.
    const frame = requestAnimationFrame(() => {
      const target = trigger.current?.checkVisibility({ visibilityProperty: true })
        ? trigger.current
        : container?.querySelector<HTMLButtonElement>('.thread-panel button')
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, trigger, container])
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={narrow}>
      <DialogPanel container={container} finalFocus={trigger}>
        <InfoHeader topic={topic} narrow={narrow} onClose={() => onOpenChange(false)} onFailure={onFailure} />
        <Tabs defaultValue="overview" className="min-h-0 flex-1">
          <div className="channel-info-tab-list">
            <TabsList variant="line" className="w-full min-h-11 shrink-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tools">Tools & skills</TabsTrigger>
              <TabsTrigger value="shared">Shared</TabsTrigger>
              <TabsTrigger value="work">Work</TabsTrigger>
            </TabsList>
          </div>
          <div className="channel-info-scroll">
            {failure !== '' && (
              <p role="alert" className="channel-info-error">
                {failure}
              </p>
            )}
            <TabsContent value="overview" keepMounted>
              <section className="channel-info-section">
                <ChannelDetails topic={topic} />
              </section>
            </TabsContent>
            <TabsContent value="tools">
              <ChannelTools topic={topic} onEdit={() => setSetupOpen(true)} />
            </TabsContent>
            <TabsContent value="shared">
              <ChannelShared topic={topic} />
            </TabsContent>
            <TabsContent value="work">
              <ChannelWork topic={topic} />
            </TabsContent>
          </div>
        </Tabs>
        <TopicSetupDrawer topic={topic} open={setupOpen} onOpenChange={setSetupOpen} />
      </DialogPanel>
    </Dialog>
  )
}

function InfoHeader({
  topic,
  narrow,
  onClose,
  onFailure,
}: {
  readonly topic: TopicView
  readonly narrow: boolean
  readonly onClose: () => void
  readonly onFailure: (message: string) => void
}) {
  return (
    <header className="channel-info-head" data-app-cover>
      {narrow && (
        <Button className="size-11" variant="ghost" aria-label="Back to channel" onClick={onClose}>
          <ArrowLeftIcon />
        </Button>
      )}
      <div>
        <p className="channel-info-kicker">Channel info</p>
        <DialogTitle>#{topic.name}</DialogTitle>
      </div>
      <ChannelMenu topic={topic} onFailure={onFailure} />
      {!narrow && (
        <Button className="size-11" variant="ghost" aria-label="Close channel info" onClick={onClose}>
          <XIcon />
        </Button>
      )}
    </header>
  )
}
