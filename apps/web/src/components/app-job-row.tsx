import { Link } from '@tanstack/react-router'
import type { AgentAppChange, AgentAppJob, AgentAppSummary } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { jobLine, jobTrouble } from '../lib/app-jobs.ts'
import { dateTime } from '../lib/format.ts'
import { StatusLabel } from './status-label.tsx'
import { useMinute } from './use-now.ts'

/**
 * One schedule of a built app (ADR 0021), on the app's page and on Work: what it runs and when, that it needs the owner
 * when it is paused or its last run failed or waited for them, how the last run went, and Pause or Resume and Run now.
 * On Work it names its app, linked to the app's page, where the rest of it is managed.
 */
export function AppJobRow({
  job,
  busy,
  run,
  app,
  failure = '',
}: {
  readonly job: AgentAppJob
  readonly busy: boolean
  readonly run: (change: AgentAppChange) => void
  readonly app?: Pick<AgentAppSummary, 'name' | 'title'>
  /** Why the owner's last change to it failed, in place of nothing. */
  readonly failure?: string
}) {
  const paused = job.paused !== null
  const now = useMinute() * 1000
  const trouble = jobTrouble(job)
  return (
    <li className="apps-row">
      <div className="min-w-0 flex-1">
        {(app !== undefined || trouble) && (
          <p className="flex flex-wrap items-center gap-2">
            {app !== undefined && (
              <Link
                to="/apps/$name"
                params={{ name: app.name }}
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                {app.title}
              </Link>
            )}
            {trouble && <StatusLabel label={{ text: 'Needs you', tone: 'attention' }} />}
          </p>
        )}
        <p className="text-sm">{jobLine(job, now)}</p>
        {job.lastAt !== null && (
          <p className="text-xs text-muted-foreground">
            Last run {dateTime(job.lastAt)}: {job.status ?? 'none'}
            {job.error === null ? '' : ` · ${job.error}`}
          </p>
        )}
        {failure !== '' && <p className="text-xs text-destructive">{failure}</p>}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => run({ kind: 'pause', action: job.action, paused: !paused })}
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ kind: 'run', action: job.action })}>
        Run now
      </Button>
    </li>
  )
}
