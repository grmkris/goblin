// The Settings cards about the agent itself: today's usage, what it remembers, and whether it may work while the owner
// is away. Each reads inside its own QueryBoundary, so one that fails leaves the others usable.
import { type ReactNode, useId } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import {
  Alert,
  AlertDescription,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Count,
  Meter,
  Skeleton,
  Switch,
} from '@goblin/ui'
import { memoryQuery, residentQuery, setResidentMutation, usageQuery } from '../agent/queries.ts'
import { dayAndMonth } from '../lib/format.ts'
import { residentStatus } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary, QueryError } from '../lib/query/query-boundary.tsx'
import { budgetFraction } from '../lib/usage.ts'
import { StatusLabel } from './status-label.tsx'

/**
 * Today's tokens, against the deployment's daily cap when it sets one, rolling as they change. It is read again
 * whenever a run ends, since that is when a turn's usage is recorded (`lib/workspace/invalidations.ts`); a failed
 * re-read keeps the last value and says why.
 */
function UsageMeter() {
  const read = useSuspenseQuery(usageQuery)
  const usage = read.data
  const share = budgetFraction(usage)
  const figures = (
    <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
      <Count value={usage.used} size="display" />
      <span>
        {usage.limit === null ? (
          'tokens'
        ) : (
          <>
            of <Count value={usage.limit} /> tokens
          </>
        )}
      </span>
      {share !== undefined && <Count value={share} percent className="ml-auto" />}
    </p>
  )
  return (
    <>
      {read.isRefetchError && (
        <QueryError error={read.error} action="read today's usage" onRetry={() => void read.refetch()} />
      )}
      {share === undefined ? (
        figures
      ) : (
        <Meter value={share * 100} aria-label="Daily token cap used">
          {figures}
        </Meter>
      )}
    </>
  )
}

/** Today's model usage in tokens, against the deployment's daily cap when it sets one. */
export function UsageCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's usage</CardTitle>
        <CardDescription>
          Tokens your agent's model calls used today, each response's input, output and cached context together. It
          starts again at 00:00 UTC.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <QueryBoundary action="read today's usage" pending={<Skeleton className="h-10 w-full" />}>
            <UsageMeter />
          </QueryBoundary>
        </div>
      </CardContent>
    </Card>
  )
}

function MemoryCount() {
  const status = useSuspenseQuery(memoryQuery()).data
  return (
    <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
      <Count value={status.messages} size="display" />
      <span>
        messages remembered, <Count value={status.summarized} /> of them as summaries
      </span>
    </p>
  )
}

/** Main's memory: what the agent remembers of the main conversation, and how much of it it reads as summaries. */
export function MemoryCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          Your agent remembers #Personal in full. It reads older messages as one-line summaries it can open again, so
          the conversation never has to end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="read what your agent remembers" pending={<Skeleton className="h-8 w-64" />}>
          <MemoryCount />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}

/** The resident card's heading, with `action` (the switch, or its placeholder while the status loads) beside it. */
function ResidentHeader({ id, action }: { readonly id: string; readonly action: ReactNode }) {
  return (
    <CardHeader>
      <CardTitle id={id}>Work while you're away</CardTitle>
      <CardDescription>
        Lets your agent use the tools you allowed when you are not watching: for apps you connected, routines and
        Sources. It stays on until you turn it off.
      </CardDescription>
      <CardAction>{action}</CardAction>
    </CardHeader>
  )
}

function Resident({ id }: { readonly id: string }) {
  const status = useSuspenseQuery(residentQuery).data
  const change = useMutation(setResidentMutation)
  const pending = change.isPending
  const failure =
    change.error === null ? '' : messageOf(change.error, 'change whether your agent may work while you are away')
  return (
    <>
      <ResidentHeader
        id={id}
        action={
          <Switch
            checked={status.state === 'active'}
            disabled={pending}
            aria-busy={pending}
            aria-labelledby={id}
            onCheckedChange={(checked) => change.mutate(checked)}
          />
        }
      />
      {failure && (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        </CardContent>
      )}
      <CardContent>
        <div className="card-line">
          <StatusLabel label={residentStatus(status.state)} />
          {status.state === 'active' && status.grantedAt !== undefined && (
            <span className="card-line-meta">since {dayAndMonth(status.grantedAt * 1000)}</span>
          )}
        </div>
      </CardContent>
    </>
  )
}

/**
 * Resident authority, as the owner meets it: whether the agent may use the tools they allowed while they are away. It
 * lasts 30 days from their last visit; turning it off stops all outbound use until they turn it on again.
 */
export function ResidentCard() {
  const id = useId()
  return (
    <Card>
      <QueryBoundary
        action="read whether your agent may work while you are away"
        pending={<ResidentHeader id={id} action={<Skeleton className="h-5 w-9" />} />}
      >
        <Resident id={id} />
      </QueryBoundary>
    </Card>
  )
}
