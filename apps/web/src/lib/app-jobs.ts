import type { AgentAppJob, AgentAppSummary } from '@goblin/contracts'

const HOW_OFTEN: Readonly<Record<AgentAppJob['every'], string>> = {
  '15m': 'every 15 minutes',
  '30m': 'every 30 minutes',
  '1h': 'hourly',
  '3h': 'every 3 hours',
  '6h': 'every 6 hours',
  '12h': 'twice a day',
  '1d': 'daily',
}

/** Whether a schedule needs the owner's eye: paused, or its last run failed or waited for them. */
export const jobTrouble = (job: AgentAppJob): boolean =>
  job.paused !== null || job.status === 'failed' || job.status === 'waiting'

/** An instant as the owner reads it: the time today, otherwise with the weekday. */
export function whenText(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** One schedule as a line in the App's bar: the action, how often, and when it runs next or why it does not. */
export function jobLine(job: AgentAppJob, now: number): string {
  const what = `${job.action} ${HOW_OFTEN[job.every]}`
  if (job.paused === 'owner') return `${what} · paused`
  if (job.paused === 'failures') return `${what} · paused after ${String(job.failures)} failures`
  const last = job.status === 'failed' ? ' · last run failed' : job.status === 'waiting' ? ' · waiting for you' : ''
  return `${what} · next ${whenText(job.nextAt, now)}${last}`
}

/** A built app's schedule as Work lists it: the job, with the app it belongs to. */
export type AppSchedule = { readonly app: AgentAppSummary; readonly job: AgentAppJob }

/**
 * Every built app's schedules, from the whole list of apps, so an app without a view or with its view closed still
 * shows: those that need the owner first, then by when they run next; app and action keep the order still between
 * reads.
 */
export const appSchedules = (apps: readonly AgentAppSummary[]): readonly AppSchedule[] =>
  apps
    .flatMap((app) => app.jobs.map((job) => ({ app, job })))
    .toSorted(
      (a, b) =>
        Number(jobTrouble(b.job)) - Number(jobTrouble(a.job)) ||
        a.job.nextAt - b.job.nextAt ||
        a.app.title.localeCompare(b.app.title) ||
        a.job.action.localeCompare(b.job.action),
    )
