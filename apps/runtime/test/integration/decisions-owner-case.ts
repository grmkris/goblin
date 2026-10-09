import { DecisionProposal, WorkspaceSnapshot } from '@goblin/contracts'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { call, ownerFetch, person, type Person } from './owner-requests.ts'

async function snapshot(base: string, owner: Person): Promise<WorkspaceSnapshot> {
  const response = await call(base, owner, '/api/workspace/events')
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (let chunk = await reader?.read(); chunk !== undefined && !chunk.done; chunk = await reader?.read()) {
      buffer += decoder.decode(chunk.value, { stream: true })
      const frame = buffer.split('\n\n').find((part) => part.startsWith('event: snapshot'))
      const data = frame === undefined ? undefined : /^data: (.*)$/mu.exec(frame)?.[1]
      if (data !== undefined) return Schema.decodeUnknownSync(WorkspaceSnapshot)(JSON.parse(data))
    }
    throw new Error('missing decision snapshot')
  } finally {
    await reader?.cancel()
  }
}
export async function decisionsOwnerCase(base: string): Promise<void> {
  const owner = await person(base)
  const other = await person(base)
  for (const who of [owner, other])
    await call(base, who, '/__test/billing/override', { userId: who.userId, dailyCredits: 1000 })
  const seeded = Schema.decodeUnknownSync(DecisionProposal)(
    await (await call(base, owner, '/__test/decisions/seed')).json(),
  )
  const url = `${base}/api/decisions/${seeded.id}`
  const body = JSON.stringify({ label: 'confirm' })
  expect(
    (
      await ownerFetch(url, {
        method: 'POST',
        headers: { cookie: owner.cookie, origin: 'https://goblin.test', 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await ownerFetch(url, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json', 'x-goblin-csrf': '1' },
        body,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await call(
        base,
        other,
        `/api/decisions/${seeded.id}?agent=${owner.userId}`,
        { label: 'confirm' },
        { 'x-goblin-workspace': owner.userId },
      )
    ).status,
  ).toBe(404)
  expect((await call(base, owner, `/api/decisions/${seeded.id}`, { label: 'automatic' })).status).toBe(400)
  const before = await snapshot(base, owner)
  expect(before.proposals).toEqual([seeded])
  expect((await snapshot(base, other)).proposals).toEqual([])
  const first = await call(base, owner, `/api/decisions/${seeded.id}`, { label: 'confirm' })
  expect(first.status).toBe(200)
  const confirmed = Schema.decodeUnknownSync(DecisionProposal)(await first.json())
  expect(confirmed.state).toBe('confirmed')
  expect(await (await call(base, owner, `/api/decisions/${seeded.id}`, { label: 'confirm' })).json()).toEqual(confirmed)
  expect((await call(base, owner, `/api/decisions/${seeded.id}`, { label: 'dismiss' })).status).toBe(409)
  expect((await snapshot(base, owner)).proposals).toEqual([confirmed])
}
