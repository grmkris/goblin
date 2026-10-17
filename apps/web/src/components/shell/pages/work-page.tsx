import { useMutation, useQuery } from '@tanstack/react-query'
import type { PersonaInvocationView, PersonaView } from '@goblin/contracts'
import { agentAppsQuery, changeAgentAppMutation } from '../../../agent-apps/queries.ts'
import { healthQuery } from '../../../auth/queries.ts'
import { type AppSchedule, appSchedules } from '../../../lib/app-jobs.ts'
import { relativeTime } from '../../../lib/format.ts'
import { messageOf } from '../../../lib/query/app-error.ts'
import { QueryError } from '../../../lib/query/query-boundary.tsx'
import { subagentState } from '../../../lib/subagent-state.ts'
import { threadTitle } from '../../../lib/threads.ts'
import { type WorkList, workLists } from '../../../lib/work.ts'
import {
  useActivities,
  useActivity,
  useConversation,
  useConversations,
  useInvocations,
  usePersonas,
} from '../../../lib/workspace/hooks.ts'
import { AppJobRow } from '../../app-job-row.tsx'
import { PageSection } from '../../page-section.tsx'
import { SubagentStateIcon, SubagentStateText } from '../../parts/subagent-block.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import { RoutinesSection } from '../../routines.tsx'
import { useMinute } from '../../use-now.ts'
import { ChatRow, RowContents } from './chat-link.tsx'

const STATES: Readonly<Record<PersonaInvocationView['state'], string>> = {
  pending: 'waiting',
  running: 'answering…',
  answered: 'answered',
  failed: 'failed',
  stopped: 'stopped',
}

/** One Delegate (a subagent): its state, its name, who started it and where it stands; it opens in its panel. */
function DelegateRow({ id }: { readonly id: string }) {
  const view = useConversation(id)
  const activity = useActivity(id)
  const spawner = threadTitle(useConversation(view?.parent))
  if (view === undefined) return null
  const state = subagentState(view, activity)
  return (
    <li>
      <ChatRow chat={view.id}>
        <RowContents
          mark={<SubagentStateIcon state={state} />}
          title={threadTitle(view)}
          meta={
            <>
              Delegate from {spawner} · <SubagentStateText state={state} />
            </>
          }
        />
      </ChatRow>
    </li>
  )
}

/** One Persona answer: the Persona's mark and name, where the answer stands and since when; it opens its chat. */
function AnswerRow({
  invocation,
  persona,
  now,
}: {
  readonly invocation: PersonaInvocationView
  readonly persona: PersonaView | undefined
  readonly now: number
}) {
  return (
    <li>
      <ChatRow chat={invocation.chat}>
        <RowContents
          mark={persona === undefined ? null : <PersonaAvatar avatar={persona.avatar} size="sm" />}
          title={persona === undefined ? 'A persona' : `@${persona.name}`}
          meta={`Persona answer · ${STATES[invocation.state]} · ${relativeTime(invocation.settledAt ?? invocation.createdAt, now)}`}
        />
      </ChatRow>
    </li>
  )
}

/** A list of delegated work: its Delegates, then its Persona answers, each row saying which it is. */
function WorkRows({ list, now }: { readonly list: WorkList; readonly now: number }) {
  const personas = new Map(usePersonas().map((persona) => [persona.id, persona]))
  return (
    <ul className="list-rows">
      {list.delegates.map((view) => (
        <DelegateRow key={view.id} id={view.id} />
      ))}
      {list.answers.map((invocation) => (
        <AnswerRow
          key={`${invocation.operationId}:${invocation.persona}`}
          invocation={invocation}
          persona={personas.get(invocation.persona)}
          now={now}
        />
      ))}
    </ul>
  )
}

/** What is running now, which is what Work's count counts; it says so when nothing is. */
function Running({ list, now }: { readonly list: WorkList; readonly now: number }) {
  const count = list.delegates.length + list.answers.length
  return (
    <PageSection id="running" title="Running" {...(count > 0 && { count })}>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is running.</p>
      ) : (
        <WorkRows list={list} now={now} />
      )}
    </PageSection>
  )
}

/** One built app's schedule, changed through that app: a change that failed says why in the row. */
function AppScheduleRow({ schedule: { app, job } }: { readonly schedule: AppSchedule }) {
  const change = useMutation(changeAgentAppMutation(app.name))
  // expected: a refused change shows why in its row, and the schedule stays as it was
  const failure = change.error === null ? '' : messageOf(change.error, 'change the schedule')
  return <AppJobRow job={job} busy={change.isPending} run={change.mutate} app={app} failure={failure} />
}

/**
 * Every built app's schedules (ADR 0021), those that need the owner first, each linked to its app's page; what a
 * schedule waits for is answered in Activity. An optional section: a failed read shows in its place, with a retry, so
 * it never passes for having none.
 */
function AppSchedules() {
  const read = useQuery(agentAppsQuery)
  const schedules = appSchedules(read.data ?? [])
  if (schedules.length === 0 && read.error === null) return null
  return (
    <PageSection
      id="app-schedules"
      title="App schedules"
      {...(schedules.length > 0 && { count: schedules.length })}
      note="What the apps your agent built run on their own."
    >
      {read.error !== null && (
        <QueryError error={read.error} action="read your app schedules" onRetry={() => void read.refetch()} />
      )}
      {schedules.length > 0 && (
        <ul className="apps-list">
          {schedules.map((schedule) => (
            <AppScheduleRow key={`${schedule.app.name}:${schedule.job.action}`} schedule={schedule} />
          ))}
        </ul>
      )}
    </PageSection>
  )
}

/**
 * `/work`: what is running and what the owner scheduled. Running (the Delegates at work and the Persona answers on
 * their way), the routines to review and change, every built app's schedules, and the recent results.
 */
export function WorkPage() {
  const now = useMinute()
  const { running, recent } = workLists(useConversations(), useActivities(), useInvocations())
  // A deployment without agent apps (ADR 0064) has no app schedules; until /health says so, they are read.
  const apps = useQuery(healthQuery).data?.features?.agentApps !== false
  return (
    <div className="page-stack">
      <Running list={running} now={now} />
      <RoutinesSection />
      {apps && <AppSchedules />}
      {recent.delegates.length + recent.answers.length > 0 && (
        <PageSection id="recent" title="Recent results">
          <WorkRows list={recent} now={now} />
        </PageSection>
      )}
    </div>
  )
}
