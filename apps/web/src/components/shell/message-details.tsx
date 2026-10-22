import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Duration,
  TimelineBar,
  ToolCallMeta,
  ToolCallStatus,
  ToolCallTitle,
} from '@goblin/ui'
import { InfoIcon } from 'lucide-react'
import { detailsQuery } from '../../inspect/queries.ts'
import { type DetailOutcome, type DetailStep, type DetailsView, detailsView } from '../../lib/details.ts'
import { durationText } from '../../lib/format.ts'
import type { Named } from '../../lib/parts.ts'
import { describeError, withRef } from '../../lib/query/app-error.ts'
import { QueryError } from '../../lib/query/query-boundary.tsx'
import { useConnectionLabels } from '../../mcp/hooks.ts'
import { useNow } from '../use-now.ts'
import { useOpenChat } from './panel.tsx'

/** "Answered in 3.5s": the outcome sentence, its duration counting while the turn runs. */
function Outcome({ outcome }: { readonly outcome: DetailOutcome }) {
  return (
    <>
      {outcome.before}
      {outcome.ms !== undefined && (
        <>
          {' '}
          <Duration ms={outcome.ms} running={outcome.running === true} />
        </>
      )}
      {outcome.after}
    </>
  )
}

/**
 * One step, as the chat's tool rows read: the lifecycle dot, what goblin did with what it reached in the foreground,
 * and its time. Under it, when it has one to compare, its bar on the turn's timeline (said in words for a screen
 * reader), then why it failed or was held, then what changed before it.
 */
function Step({ step, named }: { readonly step: DetailStep; readonly named: Named }) {
  const failed = step.state === 'error'
  return (
    <li className="flex flex-col gap-1">
      <span className="flex min-w-0 items-center gap-2 text-13 text-muted-foreground">
        <ToolCallStatus state={step.state} />
        <ToolCallTitle>
          {step.lead}
          {step.model !== undefined && (
            <>
              {' '}
              <b className="font-medium text-foreground">{step.model}</b>
            </>
          )}
          {step.server !== undefined && (
            <>
              {' '}
              <b className="font-medium text-foreground">{named(step.server)}</b>
            </>
          )}
          {step.tool !== undefined && ` · ${step.tool}`}
        </ToolCallTitle>
        {step.ms !== undefined && (
          <ToolCallMeta className="ms-auto">
            <Duration ms={step.ms} running={step.state === 'running'} />
          </ToolCallMeta>
        )}
      </span>
      {step.bar !== undefined && (
        <>
          <span className="ps-3.5">
            <TimelineBar start={step.bar.left} length={step.bar.width} failed={failed} />
          </span>
          <span className="sr-only">{`started ${durationText(step.offsetMs)} in`}</span>
        </>
      )}
      {step.problem !== undefined && (
        <span className={failed ? 'ps-3.5 text-xs text-destructive' : 'ps-3.5 text-xs text-muted-foreground'}>
          {step.problem}
        </span>
      )}
      {step.note !== undefined && <span className="ps-3.5 text-xs text-muted-foreground">{step.note}</span>}
    </li>
  )
}

/** The drawer's body for a read it has: the steps, what they led to, what was not recorded, and what it ran with. */
export function DetailsContent({
  view,
  named,
  onOpen,
}: {
  readonly view: DetailsView
  readonly named: Named
  readonly onOpen: (chat: string) => void
}) {
  return (
    <>
      {view.steps.length > 0 && (
        <ol className="flex flex-col gap-2.5" aria-label="Steps">
          {view.steps.map((step) => (
            <Step key={step.key} step={step} named={named} />
          ))}
        </ol>
      )}
      {view.related.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="What it led to">
          {view.related.map((each) => (
            <li key={each.operation} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{each.label}</span>
              {each.chat !== undefined && (
                <Button variant="ghost" size="sm" onClick={() => onOpen(each.chat ?? '')}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.gaps !== undefined && <p className="text-xs text-pretty text-muted-foreground">{view.gaps}</p>}
      {view.footer !== undefined && (
        <p className="text-xs text-pretty text-muted-foreground tabular-nums">{view.footer}</p>
      )}
    </>
  )
}

/** The open drawer: its title, the outcome as its description, then the read it is about. */
function DetailsSheet({ chat, entry }: { readonly chat: string; readonly entry: number }) {
  const details = useQuery(detailsQuery(chat, entry))
  const named = useConnectionLabels()
  const openChat = useOpenChat()
  const now = useNow(details.data?.turn?.status === 'started')
  const view = details.data === undefined ? undefined : detailsView(details.data, now)
  const missing = details.error !== null && describeError(details.error).kind === 'not_found'
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-xl flex-col">
      <DrawerHeader>
        <DrawerTitle>Details</DrawerTitle>
        <DrawerDescription>
          {view !== undefined ? (
            <Outcome outcome={view.outcome} />
          ) : details.error === null ? (
            'Reading what happened…'
          ) : missing ? (
            withRef('Nothing is recorded for this message yet.', details.error)
          ) : (
            'What happened could not be read.'
          )}
        </DrawerDescription>
      </DrawerHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {view !== undefined && <DetailsContent view={view} named={named} onOpen={openChat} />}
        {details.error !== null && !missing && (
          <QueryError error={details.error} action="read the details" onRetry={() => void details.refetch()} />
        )}
      </div>
    </div>
  )
}

/**
 * The message pill's Details: a sheet of what goblin did behind message `entry` of `chat`, in the owner's words (the
 * inspect `details` read). It reads only while it is open.
 */
export function DetailsAction({ chat, entry }: { readonly chat: string; readonly entry: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger render={<button type="button" className="message-action" aria-label="Details" title="Details" />}>
        <InfoIcon aria-hidden />
      </DrawerTrigger>
      <DrawerContent>{open && <DetailsSheet chat={chat} entry={entry} />}</DrawerContent>
    </Drawer>
  )
}
