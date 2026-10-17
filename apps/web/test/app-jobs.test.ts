import type { AgentAppJob, AgentAppSummary } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { appSchedules, jobLine, jobTrouble, whenText } from '../src/lib/app-jobs.ts'

const now = new Date(2026, 9, 6, 10, 7).getTime()
const job: AgentAppJob = {
  action: 'refresh',
  every: '1h',
  at: null,
  nextAt: new Date(2026, 9, 6, 11, 0).getTime(),
  lastAt: null,
  status: null,
  error: null,
  failures: 0,
  paused: null,
}

describe('app jobs', () => {
  it('say what runs, how often and when next', () => {
    expect(jobLine(job, now)).toBe(`refresh hourly · next ${whenText(job.nextAt, now)}`)
    expect(whenText(new Date(2026, 9, 7, 6, 30).getTime(), now)).toMatch(/\S+ \S+/u)
    expect(jobTrouble(job)).toBe(false)
  })
  it('say why a schedule needs the owner', () => {
    expect(jobLine({ ...job, status: 'waiting' }, now)).toMatch(/waiting for you$/u)
    expect(jobLine({ ...job, status: 'failed', failures: 2 }, now)).toMatch(/last run failed$/u)
    expect(jobLine({ ...job, paused: 'failures', failures: 10 }, now)).toBe('refresh hourly · paused after 10 failures')
    expect(jobLine({ ...job, paused: 'owner' }, now)).toBe('refresh hourly · paused')
    expect(jobTrouble({ ...job, paused: 'owner' })).toBe(true)
  })
})

const app = (name: string, jobs: readonly AgentAppJob[], view: string | null = null): AgentAppSummary => ({
  name,
  title: name.toUpperCase(),
  description: '',
  home: '1',
  app: view,
  version: 1,
  revision: 0,
  jobs,
  waiting: 0,
  failure: null,
  updatedAt: 1,
})
const order = (apps: readonly AgentAppSummary[]) =>
  appSchedules(apps).map((each) => `${each.app.name} ${each.job.action}`)

describe('app schedules on Work', () => {
  it('lists every app’s schedules, those without a view too, the ones that need the owner first, then by next run', () => {
    const schedules = order([
      app('tracker', [
        { ...job, action: 'refresh', nextAt: 30 },
        { ...job, action: 'digest', nextAt: 10 },
      ]),
      app('fetcher', [{ ...job, action: 'pull', nextAt: 20, status: 'failed' }]),
      app('notes', [{ ...job, action: 'sync', nextAt: 5, paused: 'owner' }], 'app_7'),
      app('quiet', []),
    ])
    expect(schedules).toEqual(['notes sync', 'fetcher pull', 'tracker digest', 'tracker refresh'])
  })
  it('keeps one order between reads when two run at the same time', () => {
    const same = [
      app('b', [{ ...job, action: 'go' }]),
      app('a', [
        { ...job, action: 'go' },
        { ...job, action: 'at' },
      ]),
    ]
    expect(order(same)).toEqual(['a at', 'a go', 'b go'])
    expect(order(same.toReversed())).toEqual(order(same))
  })
})
