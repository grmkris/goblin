import { PersonaPage, TopicPage } from '@goblin/contracts'
import { sql } from 'drizzle-orm'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { appTopics } from '../../../src/storage/topics.ts'
import { get, json, post } from './fixture.ts'
import { organizing } from './organizing.ts'

const scout = { name: 'Scout', avatar: { glyph: 'S', hue: 120 }, role: 'Finds things out', instructions: 'Be brief.' }

/** The grant the edge forwards for a key (ADR 0081): every scope, and one server it may name in a setup. */
const grant = (keyId = 'key-1', scopes = ['topics', 'conversations', 'personas'], name = keyId) => ({
  'x-goblin-caller': JSON.stringify({ kind: 'key', keyId, name, scopes, servers: ['mycut'], origins: [] }),
})
const KEY = grant()
const OTHER = grant('key-2')

const topicPage = async (response: Promise<Response>) =>
  Schema.decodeUnknownSync(TopicPage)(await (await response).json())
const personaPage = async (response: Promise<Response>) =>
  Schema.decodeUnknownSync(PersonaPage)(await (await response).json())

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

  it("never lets a key name one of the owner's own subscriptions for a Persona, while the owner may (ADR 0087)", async () => {
    const { fetch } = organizing()
    const refused = await fetch(post('/api/personas', { ...scout, model: 'sub/opus', operationId: 'svc:p:1' }, KEY))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'persona_model' } })
    expect((await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:2' }, KEY))).status).toBe(201)
    const edited = await fetch(json('PATCH', '/api/personas/1', { model: 'sub/opus', expectedRevision: 1 }, KEY))
    expect(edited.status).toBe(400)
    const owners = await fetch(post('/api/personas', { ...scout, name: 'Owl', model: 'sub/opus', operationId: 'own' }))
    expect(owners.status).toBe(201)
  })

  it('lists only its own Topics and Personas, newest change first, page by page; the owner lists every one', async () => {
    const { fetch, db } = organizing()
    for (const n of [1, 2, 3])
      await fetch(post('/api/topics', { name: `Customer ${n}`, operationId: `svc:topic:${n}` }, KEY))
    await fetch(post('/api/topics', { name: 'Customer of another', operationId: 'other:topic' }, OTHER))
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    // A change moves a Topic to the front: each change here is a second later than the one before.
    db.update(appTopics)
      .set({ updatedAt: sql`${appTopics.id}` })
      .run()
    await fetch(json('PATCH', '/api/topics/2', { name: 'Customer one' }, KEY))
    const first = await topicPage(fetch(get('/api/topics?limit=2', KEY)))
    expect(first.topics.map((topic) => topic.name)).toEqual(['Customer one', 'Customer 3'])
    expect(first.topics[0]).toEqual({
      id: 2,
      name: 'Customer one',
      conversation: expect.any(String),
      revision: 2,
      archived: false,
      searchExcluded: false,
      room: { key: 'key-1' },
      updatedAt: expect.any(Number),
    })
    expect(first.next).toMatch(/^\d+\.\d+$/u)
    const second = await topicPage(fetch(get(`/api/topics?limit=2&cursor=${first.next}`, KEY)))
    expect(second).toEqual({ topics: [expect.objectContaining({ name: 'Customer 2' })] })
    const others = await topicPage(fetch(get('/api/topics', OTHER)))
    expect(others.topics.map((topic) => topic.name)).toEqual(['Customer of another'])
    const owner = await topicPage(fetch(get('/api/topics?limit=100')))
    expect(owner.topics).toHaveLength(6)
    expect(owner.topics.find((topic) => topic.personal === true)?.id).toBe(1)
    expect((await fetch(get('/api/topics?limit=101', KEY))).status).toBe(400)
    expect((await fetch(get('/api/topics?cursor=nope', KEY))).status).toBe(400)

    await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:1' }, KEY))
    const setup = { mcpServers: [{ connectionId: 'mycut', tools: ['job_submit', 'job_status'] }], skills: [], apps: [] }
    await fetch(
      post('/api/personas', { ...scout, name: 'Editor', model: 'model-a', setup, operationId: 'svc:p:2' }, KEY),
    )
    await fetch(post('/api/personas', { ...scout, name: 'Owl', operationId: 'owner-p' }))
    const personas = await personaPage(fetch(get('/api/personas', KEY)))
    expect(personas.personas.map((persona) => persona.name)).toEqual(['Editor', 'Scout'])
    expect(personas.personas[0]).toEqual({
      id: 2,
      name: 'Editor',
      role: scout.role,
      avatar: scout.avatar,
      madeBy: { key: 'key-1' },
      revision: 1,
      model: 'model-a',
      setup: { servers: [{ connectionId: 'mycut', tools: 2 }], skills: 0, apps: 0 },
      updatedAt: expect.any(Number),
    })
    const named = await personaPage(fetch(get('/api/personas?name=edit', KEY)))
    expect(named.personas.map((persona) => persona.id)).toEqual([2])
    expect((await personaPage(fetch(get('/api/personas?name=Owl', KEY)))).personas).toEqual([])
    expect((await personaPage(fetch(get('/api/personas', OTHER)))).personas).toEqual([])
    expect((await personaPage(fetch(get('/api/personas')))).personas).toHaveLength(3)
    // A key with no personas scope lists none of them.
    expect((await fetch(get('/api/personas', grant('key-1', ['topics'])))).status).toBe(403)
  })

  it('names the key on what it made, to the key and the owner, and on nothing it did not (ADR 0108)', async () => {
    const { fetch, db, topics, personas } = organizing()
    const named = grant('key-1', ['topics', 'personas'], 'swarmm-prod')
    // Made before names were kept: its key's id stands in until the key makes something again.
    db.run(sql`INSERT INTO app_key_reach (key_id, kind, resource_id, created_at) VALUES ('key-1', 'topic', 9, 1)`)
    const made = await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, named))
    expect(await made.json()).toMatchObject({ id: 2, room: { key: 'swarmm-prod' } })
    const persona = await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:1' }, named))
    expect(await persona.json()).toMatchObject({ id: 1, madeBy: { key: 'swarmm-prod' } })
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    await fetch(post('/api/personas', { ...scout, name: 'Owl', operationId: 'owner-p' }))
    expect(topics.list().map((topic) => [topic.id, topic.room?.key])).toEqual([
      [1, undefined],
      [2, 'swarmm-prod'],
      [3, undefined],
    ])
    expect(personas.list().map((each) => [each.id, each.madeBy?.key])).toEqual([
      [1, 'swarmm-prod'],
      [2, undefined],
    ])
    expect(db.all(sql`SELECT resource_id, key_name FROM app_key_reach ORDER BY kind, resource_id`)).toEqual([
      { resource_id: 1, key_name: 'swarmm-prod' },
      { resource_id: 2, key_name: 'swarmm-prod' },
      { resource_id: 9, key_name: 'swarmm-prod' },
    ])
    const owners = await topicPage(fetch(get('/api/topics')))
    expect(owners.topics.map((topic) => topic.room?.key ?? null)).toEqual([null, 'swarmm-prod', null])
  })

  it("reads back one of its own Topics with its guidance and setup, and no other's", async () => {
    const { fetch } = organizing()
    const instructions = "Answer in the customer's language."
    await fetch(post('/api/topics', { name: 'Customer 1', instructions, operationId: 'svc:topic:1' }, KEY))
    const read = await fetch(get('/api/topics/2', KEY))
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      id: 2,
      instructions,
      revision: 1,
      setup: { mcpServers: [], skills: [], apps: [], subagents: false },
    })
    expect((await fetch(get('/api/topics/2', OTHER))).status).toBe(404)
    expect((await fetch(get('/api/topics/1', KEY))).status).toBe(404)
    expect((await fetch(get('/api/topics/1'))).status).toBe(200)
  })

  it('keeps everything it made when the owner gives it another scope: reach is by key, never by scope (ADR 0084)', async () => {
    const { fetch } = organizing()
    const before = grant('key-1', ['topics', 'personas'])
    await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, before))
    await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:1' }, before))
    const after = grant('key-1', ['topics', 'personas', 'inspect'])
    expect((await topicPage(fetch(get('/api/topics', after)))).topics.map((topic) => topic.id)).toEqual([2])
    expect((await personaPage(fetch(get('/api/personas', after)))).personas.map((persona) => persona.id)).toEqual([1])
    expect((await fetch(get('/api/topics/2', after))).status).toBe(200)
    expect((await fetch(json('PATCH', '/api/personas/1', { role: 'Edits', expectedRevision: 1 }, after))).status).toBe(
      200,
    )
  })

  it('is refused past its requests for the minute, with how long to wait, and another key is not (ADR 0085)', async () => {
    const { fetch } = organizing()
    const answers = await Promise.all(
      Array.from({ length: 601 }, () => fetch(get('/api/personas?limit=1', KEY)).then((response) => response.status)),
    )
    expect(answers.filter((status) => status === 200)).toHaveLength(600)
    const refused = await fetch(get('/api/personas?limit=1', KEY))
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({
      error: { reason: 'rate_limited', retryAfter: expect.any(Number) },
    })
    expect((await fetch(get('/api/personas?limit=1', OTHER))).status).toBe(200)
  })

  it('is admitted only where its scope reaches, and never grants resident authority', async () => {
    const { fetch, resident } = organizing()
    expect((await fetch(post('/api/topics', { name: 'A', operationId: 'svc:a' }, KEY))).status).toBe(201)
    expect(resident.grants).toHaveLength(0)
    const topicsOnly = grant('key-3', ['topics'])
    const refused = await fetch(post('/api/personas', { ...scout, operationId: 'svc:p' }, topicsOnly))
    expect(refused.status).toBe(403)
    await refusedFor(refused, 'scope')
    // An endpoint no key reaches: Undo in the organize log.
    expect((await fetch(post('/api/organize/receipt-1/undo', {}, KEY))).status).toBe(403)
    await fetch(post('/api/topics', { name: 'B', operationId: 'owner-b' }))
    expect(resident.grants.length).toBeGreaterThan(0)
  })
})
