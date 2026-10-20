import { describe, expect, it } from 'vitest'
import { json, post } from './fixture.ts'
import { organizing } from './organizing.ts'

const scout = { name: 'Scout', avatar: { glyph: 'S', hue: 120 }, role: 'Finds things out', instructions: 'Be brief.' }

/** The grant the edge forwards for a key (ADR 0081): every scope, and one server it may name in a setup. */
const grant = (keyId = 'key-1', scopes = ['topics', 'conversations', 'personas']) => ({
  'x-goblin-key': JSON.stringify({ keyId, scopes, servers: ['mycut'] }),
})
const KEY = grant()
const OTHER = grant('key-2')

/** That `response` refused for `reason`. */
const refusedFor = async (response: Response, reason: string) =>
  expect(await response.json()).toMatchObject({ error: { reason } })

describe("an API key's reach (ADR 0081)", () => {
  it('makes a Topic narrowed to nothing, which it alone of the keys reaches, and never Personal', async () => {
    const { fetch, topics } = organizing()
    const made = await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, KEY))
    expect(made.status).toBe(201)
    expect(topics.get(2).setup).toEqual({ mcpServers: [], skills: [], apps: [], subagents: false })
    expect((await fetch(json('PATCH', '/api/topics/2', { name: 'Customer one' }, KEY))).status).toBe(200)
    expect((await fetch(json('PATCH', '/api/topics/2', { name: 'Taken' }, OTHER))).status).toBe(404)
    expect((await fetch(json('PATCH', '/api/topics/1', { searchExcluded: true }, KEY))).status).toBe(404)
    // The owner's session still reaches it.
    expect((await fetch(json('PATCH', '/api/topics/2', { name: 'Renamed by the owner' }))).status).toBe(200)
  })

  it("replays its own create, but never adopts the owner's Topic or Persona by an operation id", async () => {
    const { fetch } = organizing()
    expect((await fetch(post('/api/topics', { name: 'Mine', operationId: 'svc:topic:1' }, KEY))).status).toBe(201)
    expect((await fetch(post('/api/topics', { name: 'Mine', operationId: 'svc:topic:1' }, KEY))).status).toBe(201)
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    const adopted = await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }, KEY))
    expect(adopted.status).toBe(409)
    await refusedFor(adopted, 'key_reach')
    await fetch(post('/api/personas', { ...scout, operationId: 'owner-persona' }))
    const persona = await fetch(post('/api/personas', { ...scout, operationId: 'owner-persona' }, KEY))
    expect(persona.status).toBe(409)
  })

  it.each([
    ['every server', { mcpServers: 'all', skills: [], apps: [], subagents: false }],
    [
      'every tool of its server',
      { mcpServers: [{ connectionId: 'mycut', tools: 'all' }], skills: [], apps: [], subagents: false },
    ],
    [
      'a server not on the key',
      { mcpServers: [{ connectionId: 'myplan', tools: ['read'] }], skills: [], apps: [], subagents: false },
    ],
    ['an app', { mcpServers: [], skills: [], apps: ['notes'], subagents: false }],
    ['subagents', { mcpServers: [], skills: [], apps: [], subagents: true }],
  ])('refuses a setup with %s', async (_case, setup) => {
    const { fetch } = organizing()
    const refused = await fetch(post('/api/topics', { name: 'X', operationId: 'svc:x', setup }, KEY))
    expect(refused.status).toBe(403)
    await refusedFor(refused, 'key_setup')
  })

  it("keeps a Persona's setup under the ceiling, and reaches only its own Personas", async () => {
    const { fetch } = organizing()
    const setup = { mcpServers: [{ connectionId: 'mycut', tools: ['job_submit'] }], skills: [], apps: [] }
    expect((await fetch(post('/api/personas', { ...scout, setup, operationId: 'svc:p:1' }, KEY))).status).toBe(201)
    await fetch(post('/api/personas', { ...scout, name: 'Owl', operationId: 'owner-p' }))
    expect((await fetch(new Request('https://agent/api/personas/1', { headers: KEY }))).status).toBe(200)
    expect((await fetch(new Request('https://agent/api/personas/2', { headers: KEY }))).status).toBe(404)
    expect((await fetch(new Request('https://agent/api/personas/1', { headers: OTHER }))).status).toBe(404)
    const widened = await fetch(
      json('PATCH', '/api/personas/1', { setup: { ...setup, mcpServers: 'all' }, expectedRevision: 1 }, KEY),
    )
    expect(widened.status).toBe(403)
  })

  it('is admitted only where its scope reaches, and never renews resident authority', async () => {
    const { fetch, resident } = organizing()
    expect((await fetch(post('/api/topics', { name: 'A', operationId: 'svc:a' }, KEY))).status).toBe(201)
    expect(resident.renewals).toHaveLength(0)
    const topicsOnly = grant('key-3', ['topics'])
    const refused = await fetch(post('/api/personas', { ...scout, operationId: 'svc:p' }, topicsOnly))
    expect(refused.status).toBe(403)
    await refusedFor(refused, 'key_scope')
    // An endpoint no key reaches: Undo in the organize log.
    expect((await fetch(post('/api/organize/receipt-1/undo', {}, KEY))).status).toBe(403)
    await fetch(post('/api/topics', { name: 'B', operationId: 'owner-b' }))
    expect(resident.renewals.length).toBeGreaterThan(0)
  })
})
