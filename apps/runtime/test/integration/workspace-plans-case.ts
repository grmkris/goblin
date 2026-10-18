import { expect } from 'vitest'
import type { WorkspacePlanAsk } from '@goblin/contracts'
import { callOwner, type AgentFetch } from '../owner-client.ts'
import { call, lever, person, showing, signedIn, type Person } from './owner-requests.ts'
import { answerOf, ownerSend, snapshotOf } from './probe-reads.ts'
import { waitFor } from './until.ts'

const routineStates = async (me: AgentFetch) =>
  (await callOwner(me, (api) => api.routines.list())).routines.map((routine) => routine.state)

/** Real auth, owner API, Pi tool, SQLite and scheduler; the model is deterministic and sends nothing outside. */
export async function workspacePlansCase(base: string): Promise<void> {
  const who = await person(base)
  const me = signedIn(base, who)
  const other = signedIn(base, await person(base))
  const topic = await callOwner(me, (api) =>
    api.topics.create({ payload: { name: 'Setup trial', operationId: 'setup-topic' } }),
  )
  const proposal: WorkspacePlanAsk = {
    title: 'Morning and evening',
    purpose: 'Two reminders in their own Topic.',
    sources: [],
    routines: ['Morning', 'Evening'].map((title, index) => ({
      topic: topic.name,
      title,
      trigger: { kind: 'cron', expression: `0 ${index === 0 ? '9' : '18'} * * *` },
      timezone: 'UTC',
      tellMe: { on: true, copy: false },
      handTo: { kind: 'none' },
    })),
  }
  expect(
    (await ownerSend(me, '1', `call workspace_propose ${JSON.stringify(proposal)}`, 'workspace-proposal')).ok,
  ).toBe(true)
  const read = () => callOwner(me, (api) => api.workspacePlans.list())
  const page = await waitFor(read, ({ plans }) => plans.some((plan) => plan.state === 'proposed'), 'setup review')
  const review = page.plans[0]
  if (review === undefined) throw new Error('no setup review')
  expect(review.items.map((item) => item.kind)).toEqual(['routine', 'routine'])
  expect(await routineStates(me)).toEqual(['proposed', 'proposed'])
  await showing(me, '1', 'workspace-plan')
  const params = { id: review.id }
  const payload = { revision: review.revision }
  expect(await answerOf(other, (api) => api.workspacePlans.get({ params }))).toBe('NotFound')
  expect(await answerOf(other, (api) => api.workspacePlans.apply({ params, payload }))).toBe('NotFound')
  expect(
    (await call(base, who, `/api/workspace-plans/${review.id}/apply`, payload, { 'x-goblin-csrf': '' })).status,
  ).toBe(403)
  expect(await answerOf(me, (api) => api.workspacePlans.apply({ params, payload: { revision: 2 } }))).toBe('Conflict')
  const applied = await callOwner(me, (api) => api.workspacePlans.apply({ params, payload }))
  expect(applied).toMatchObject({ state: 'ready', continuation: 'sent', completed: [0, 1] })
  await showing(me, '1', 'Setup configured:')
  const entries = async () => (await snapshotOf(me, '1')).entries ?? []
  const continuations = (all: Awaited<ReturnType<typeof entries>>) =>
    all.filter(
      (entry) =>
        entry.kind === 'pi.user' &&
        JSON.stringify(entry).includes('Setup configured:') &&
        JSON.stringify(entry).includes(review.title),
    )
  const before = continuations(await entries()).length
  expect(before).toBe(1)
  expect(await callOwner(me, (api) => api.workspacePlans.apply({ params, payload }))).toEqual(applied)
  expect(continuations(await entries())).toHaveLength(before)
  expect(await routineStates(me)).toEqual(['active', 'active'])
  await budgetFallback(base, who, me, proposal)
}

/** A second plan can activate when its continuation cannot spend model tokens. */
async function budgetFallback(base: string, who: Person, me: AgentFetch, proposal: WorkspacePlanAsk) {
  const read = () => callOwner(me, (api) => api.workspacePlans.list())
  await ownerSend(
    me,
    '1',
    `call workspace_propose ${JSON.stringify({ ...proposal, title: 'Budget fallback' })}`,
    'workspace-budget',
  )
  const waiting = await waitFor(
    read,
    ({ plans }) => plans.some((plan) => plan.title === 'Budget fallback' && plan.state === 'proposed'),
    'second setup',
  )
  const budgetPlan = waiting.plans.find((plan) => plan.title === 'Budget fallback')
  if (budgetPlan === undefined) throw new Error('no second review')
  await lever(base, who, 'approvals/spent')
  const kept = await callOwner(me, (api) =>
    api.workspacePlans.apply({ params: { id: budgetPlan.id }, payload: { revision: 1 } }),
  )
  expect(kept).toMatchObject({ state: 'ready', continuation: 'kept' })
  await showing(me, '1', 'app.workspace_setup')
}
