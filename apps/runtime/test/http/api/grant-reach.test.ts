import { EVERYTHING, PersonaPage, TopicPage } from '@goblin/contracts'
import { sql } from 'drizzle-orm'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Credential } from '../../../src/http/api/principal.ts'
import { appTopics } from '../../../src/storage/topics.ts'
import { credential, credentialHeaders } from '../../grants-fixture.ts'
import { get, json, post } from './fixture.ts'
import { organizing } from './organizing.ts'

const scout = { name: 'Scout', avatar: { glyph: 'S', hue: 120 }, role: 'Finds things out', instructions: 'Be brief.' }

/** An installed app whose grant is `manage` over every Topic, Persona and connection: Swarmm's as it installs. */
const APP = credential({ id: 'in-1', name: 'in-1', level: 'manage' })
/** A key whose Topics and Personas are lists, growing with what it makes (ADR 0114), and its connections `mycut`. */
const LISTED = credential({
  id: 'key-2',
  name: 'key-2',
  level: 'manage',
  extras: ['setup'],
  topics: 'list',
  personas: 'list',
  connections: 'list',
})

/** The headers that forward `forwarded`, and for a client the person it acts for with `role`. */
const as = (forwarded: Credential, role: 'owner' | 'admin' | 'member' = 'owner') => ({
  ...credentialHeaders(forwarded),
  ...(forwarded.kind === 'client'
    ? { 'x-goblin-member': JSON.stringify({ user: 'u1', role, name: 'Ana', shared: false }) }
    : {}),
})

const topicPage = async (response: Promise<Response>) =>
  Schema.decodeUnknownSync(TopicPage)(await (await response).json())
const personaPage = async (response: Promise<Response>) =>
  Schema.decodeUnknownSync(PersonaPage)(await (await response).json())

/** That `response` was refused for want of access, missing `missing`, with its widening link. */
const lacking = async (response: Response, missing: object) => {
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({
    error: {
      code: 'access_insufficient',
      missing,
      widenUrl: expect.stringMatching(/^https:\/\/goblin\.test\/consent\/widen\?grant=/u),
    },
  })
}

/** The id of what a create answered. */
const idOf = async (response: Response): Promise<number> =>
  Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(await response.json()).id

/** That `response` was refused for `reason`. */
const refusedFor = async (response: Response, reason: string) =>
  expect(await response.json()).toMatchObject({ error: { reason } })

describe('a credential reaches what its grant reaches (ADR 0114)', () => {
  it("reads the owner's own Topics and Personas with a default grant, and makes a Topic narrowed to nothing", async () => {
    const { fetch, topics } = organizing()
    await fetch(post('/api/personas', { ...scout, operationId: 'owner-p' }))
    const persona = await fetch(get('/api/personas/1', as(APP)))
    expect(persona.status).toBe(200)
    expect(await persona.json()).toMatchObject({ persona: { id: 1, name: 'Scout' } })
    const made = await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, as(APP)))
    expect(made.status).toBe(201)
    expect(topics.get(2).setup).toEqual({ mcpServers: [], skills: [], apps: [], subagents: false })
    expect((await topicPage(fetch(get('/api/topics', as(APP))))).topics.map((topic) => topic.id)).toEqual([2, 1])
    expect((await fetch(json('PATCH', '/api/topics/1', { name: 'Home' }, as(APP)))).status).toBe(200)
  })

  it('seals a Topic with manage, and leaves making a hub to a person (ADR 0115)', async () => {
    const { fetch, topics } = organizing()
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    const writer = credential({ id: 'key-w', level: 'write' })
    await lacking(await fetch(json('PATCH', '/api/topics/1', { reach: 'sealed' }, as(writer))), { level: 'manage' })
    expect(topics.get(1).reach).toBe('hub')
    expect((await fetch(json('PATCH', '/api/topics/1', { reach: 'sealed' }, as(APP)))).status).toBe(200)
    expect(topics.get(1).reach).toBe('sealed')
    const hub = await fetch(json('PATCH', '/api/topics/2', { reach: 'hub' }, as(APP)))
    expect(hub.status).toBe(403)
    await refusedFor(hub, 'hub_person')
    // A client acting for a member is refused for the member's role; the owner's session makes a hub.
    const client = credential({ kind: 'client', id: 'client-1', level: 'manage' })
    const member = await fetch(json('PATCH', '/api/topics/2', { reach: 'sealed' }, as(client, 'member')))
    expect(member.status).toBe(403)
    await refusedFor(member, 'role')
    expect((await fetch(json('PATCH', '/api/topics/2', { reach: 'hub' }))).status).toBe(200)
    expect(topics.get(2).reach).toBe('hub')
  })

  it('appends what a list-reach app makes to its list, and reaches nothing else of that kind', async () => {
    const { fetch, grants } = organizing()
    grants.set(LISTED)
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    await fetch(post('/api/personas', { ...scout, name: 'Owl', operationId: 'owner-p' }))
    expect((await fetch(post('/api/topics', { name: 'Mine', operationId: 'svc:t' }, as(LISTED)))).status).toBe(201)
    expect((await fetch(post('/api/personas', { ...scout, operationId: 'svc:p' }, as(LISTED)))).status).toBe(201)
    expect(grants.listed('key-2', 'topic')).toEqual(['3'])
    expect(grants.listed('key-2', 'persona')).toEqual(['2'])
    expect((await fetch(get('/api/topics/3', as(LISTED)))).status).toBe(200)
    await lacking(await fetch(get('/api/topics/2', as(LISTED))), { reachId: 'w1/topic/2' })
    await lacking(await fetch(get('/api/topics/1', as(LISTED))), { reachId: 'w1/topic/1' })
    await lacking(await fetch(get('/api/personas/1', as(LISTED))), { reachId: 'w1/persona/1' })
    expect((await topicPage(fetch(get('/api/topics', as(LISTED))))).topics.map((topic) => topic.id)).toEqual([3])
    expect((await personaPage(fetch(get('/api/personas', as(LISTED))))).personas.map((each) => each.id)).toEqual([2])
    // The owner's session still reaches every one.
    expect((await topicPage(fetch(get('/api/topics?limit=100')))).topics).toHaveLength(3)
  })

  it('replays its own create, but never adopts something outside its list by an operation id', async () => {
    const { fetch, grants } = organizing()
    grants.set(LISTED)
    expect((await fetch(post('/api/topics', { name: 'Mine', operationId: 'svc:t' }, as(LISTED)))).status).toBe(201)
    expect((await fetch(post('/api/topics', { name: 'Mine', operationId: 'svc:t' }, as(LISTED)))).status).toBe(201)
    expect(grants.listed('key-2', 'topic')).toEqual(['2'])
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    await lacking(await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }, as(LISTED))), {
      reachId: 'w1/topic/3',
    })
    await fetch(post('/api/personas', { ...scout, operationId: 'owner-persona' }))
    await lacking(await fetch(post('/api/personas', { ...scout, operationId: 'owner-persona' }, as(LISTED))), {
      reachId: 'w1/persona/1',
    })
    expect(grants.listed('key-2', 'topic')).toEqual(['2'])
  })

  it('takes write to make a Topic, manage for guidance or a Persona, and the setup extra for a setup', async () => {
    const { fetch } = organizing()
    const reader = credential({ id: 'key-r', level: 'read' })
    await lacking(await fetch(post('/api/topics', { name: 'A', operationId: 'r:a' }, as(reader))), { level: 'write' })
    const writer = credential({ id: 'key-w', level: 'write' })
    expect((await fetch(post('/api/topics', { name: 'A', operationId: 'w:a' }, as(writer)))).status).toBe(201)
    await lacking(
      await fetch(post('/api/topics', { name: 'B', instructions: 'Be kind.', operationId: 'w:b' }, as(writer))),
      { level: 'manage' },
    )
    await lacking(await fetch(post('/api/personas', { ...scout, operationId: 'w:p' }, as(writer))), {
      level: 'manage',
    })
    await lacking(await fetch(json('PATCH', '/api/topics/2', { name: 'A2' }, as(writer))), { level: 'manage' })
    const setup = {
      mcpServers: [{ connectionId: 'mycut', tools: ['job_submit'] }],
      skills: [],
      apps: [],
      subagents: false,
    }
    await lacking(await fetch(post('/api/topics', { name: 'C', setup, operationId: 'k:c' }, as(APP))), {
      extra: 'setup',
    })
    const setting = credential({ id: 'key-s', level: 'manage', extras: ['setup'] })
    expect((await fetch(post('/api/topics', { name: 'C', setup, operationId: 's:c' }, as(setting)))).status).toBe(201)
  })

  it('keeps a setup a list-reach credential writes within its connections', async () => {
    const { fetch, grants } = organizing()
    grants.set(LISTED, [{ kind: 'connection', id: 'mycut' }])
    const none = { mcpServers: [], skills: [], apps: [], subagents: false }
    const within = { ...none, mcpServers: [{ connectionId: 'mycut', tools: 'all' }] }
    expect(
      (await fetch(post('/api/topics', { name: 'A', setup: within, operationId: 'l:a' }, as(LISTED)))).status,
    ).toBe(201)
    await lacking(
      await fetch(
        post(
          '/api/topics',
          {
            name: 'B',
            setup: { ...none, mcpServers: [{ connectionId: 'myplan', tools: ['read'] }] },
            operationId: 'l:b',
          },
          as(LISTED),
        ),
      ),
      { reachId: 'w1/connection/myplan' },
    )
    for (const [operationId, setup] of [
      ['l:c', { ...none, mcpServers: 'all' }],
      ['l:d', { ...none, apps: ['notes'] }],
      ['l:e', { ...none, subagents: true }],
    ] as const) {
      const refused = await fetch(post('/api/topics', { name: operationId, setup, operationId }, as(LISTED)))
      expect(refused.status).toBe(403)
      await refusedFor(refused, 'setup_reach')
    }
  })

  it("never lets an app name one of the owner's own subscriptions for a Persona, while the owner may (ADR 0087)", async () => {
    const { fetch } = organizing()
    const refused = await fetch(post('/api/personas', { ...scout, model: 'sub/opus', operationId: 'svc:p:1' }, as(APP)))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'persona_model' } })
    expect((await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:2' }, as(APP)))).status).toBe(201)
    const edited = await fetch(json('PATCH', '/api/personas/1', { model: 'sub/opus', expectedRevision: 1 }, as(APP)))
    expect(edited.status).toBe(400)
    const owners = await fetch(post('/api/personas', { ...scout, name: 'Owl', model: 'sub/opus', operationId: 'own' }))
    expect(owners.status).toBe(201)
  })

  it('treats an installed app and an OAuth client with the same grant alike, a client no more than its person may', async () => {
    const { fetch, grants } = organizing()
    const client: Credential = { ...LISTED, kind: 'client', id: 'claude', name: 'Claude', grantId: 'cg_1' }
    for (const forwarded of [LISTED, client]) grants.set(forwarded)
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    const made = await Promise.all(
      [LISTED, client].map(async (forwarded) => {
        const response = await fetch(
          post('/api/topics', { name: `Of ${forwarded.id}`, operationId: `${forwarded.id}:t` }, as(forwarded)),
        )
        return idOf(response)
      }),
    )
    expect(made).toEqual([3, 4])
    expect([grants.listed('key-2', 'topic'), grants.listed('cg_1', 'topic')]).toEqual([['3'], ['4']])
    for (const [forwarded, own, other] of [
      [LISTED, 3, 4],
      [client, 4, 3],
    ] as const) {
      expect((await fetch(get(`/api/topics/${own}`, as(forwarded)))).status).toBe(200)
      await lacking(await fetch(get(`/api/topics/${other}`, as(forwarded))), { reachId: `w1/topic/${other}` })
      await lacking(await fetch(get('/api/topics/2', as(forwarded))), { reachId: 'w1/topic/2' })
    }
    // A member's client holds no more than a member: writing, never managing.
    const refused = await fetch(json('PATCH', '/api/topics/4', { name: 'Renamed' }, as(client, 'member')))
    expect(refused.status).toBe(403)
    await refusedFor(refused, 'role')
    expect((await fetch(json('PATCH', '/api/topics/4', { name: 'Renamed' }, as(client, 'admin')))).status).toBe(200)
  })

  it('reads its lists again when the auth store says its grant moved on', async () => {
    const { fetch, grants } = organizing()
    grants.set(LISTED)
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    await lacking(await fetch(get('/api/topics/2', as(LISTED))), { reachId: 'w1/topic/2' })
    // The owner widens it: the store lists Topic 2 under a new generation, which the next request forwards.
    const widened = { ...LISTED, ws: { ...LISTED.ws, generation: 2 } }
    grants.set(widened, [{ kind: 'topic', id: '2' }])
    expect((await fetch(get('/api/topics/2', as(widened)))).status).toBe(200)
  })

  it('names the app on what it made, to the app and the owner, and on nothing it did not, for display (ADR 0115)', async () => {
    const { fetch, db, topics, personas } = organizing()
    const named = credential({ id: 'app-1', name: 'swarmm-prod', level: 'manage' })
    // One a server made with no name kept: its id stands for it.
    await fetch(post('/api/topics', { name: 'Older', operationId: 'older' }))
    db.run(sql`INSERT INTO app_made_by (key_id, kind, resource_id, created_at) VALUES ('in-1', 'topic', 2, 1)`)
    expect(topics.get(2).madeBy).toEqual({ app: 'in-1' })
    const made = await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, as(named)))
    expect(await made.json()).toMatchObject({ id: 3, madeBy: { app: 'swarmm-prod' } })
    const persona = await fetch(post('/api/personas', { ...scout, operationId: 'svc:p:1' }, as(named)))
    expect(await persona.json()).toMatchObject({ id: 1, madeBy: { app: 'swarmm-prod' } })
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    await fetch(post('/api/personas', { ...scout, name: 'Owl', operationId: 'owner-p' }))
    expect(topics.list().map((topic) => [topic.id, topic.madeBy?.app])).toEqual([
      [1, undefined],
      [2, 'in-1'],
      [3, 'swarmm-prod'],
      [4, undefined],
    ])
    expect(personas.list().map((each) => [each.id, each.madeBy?.app])).toEqual([
      [1, 'swarmm-prod'],
      [2, undefined],
    ])
  })

  it("lets the owner set an app's Topic up like any other: what an app's turn may use there is its own grant's (ADR 0115)", async () => {
    const { fetch, topics } = organizing()
    await fetch(post('/api/topics', { name: 'Customer 1', operationId: 'svc:topic:1' }, as(APP)))
    const set = await fetch(json('PATCH', '/api/topics/2/setup', { set: EVERYTHING, expectedRevision: 1 }))
    expect(set.status).toBe(200)
    expect(topics.get(2).setup).toEqual(EVERYTHING)
  })

  it("keeps the name of the app that wrote a Topic's guidance, and none once a person writes it (ADR 0115)", async () => {
    const { fetch, db } = organizing()
    const guidanceBy = () =>
      db.all<{ by: string | null }>(sql`SELECT guidance_by AS by FROM app_topics WHERE id = 2`)[0]?.by
    await fetch(post('/api/topics', { name: 'Customer 1', instructions: 'Be brief.', operationId: 'k' }, as(APP)))
    expect(guidanceBy()).toBe('in-1')
    await fetch(json('PATCH', '/api/topics/2', { name: 'Customer one' }))
    expect(guidanceBy()).toBe('in-1')
    await fetch(json('PATCH', '/api/topics/2', { instructions: 'Be kind.', expectedRevision: 2 }))
    expect(guidanceBy()).toBeNull()
  })

  it('pages what it reaches, newest change first', async () => {
    const { fetch, db, grants } = organizing()
    grants.set(LISTED)
    for (const n of [1, 2, 3])
      await fetch(post('/api/topics', { name: `Customer ${n}`, operationId: `svc:topic:${n}` }, as(LISTED)))
    await fetch(post('/api/topics', { name: 'Trips', operationId: 'owner-topic' }))
    db.update(appTopics)
      .set({ updatedAt: sql`${appTopics.id}` })
      .run()
    await fetch(json('PATCH', '/api/topics/2', { name: 'Customer one' }, as(LISTED)))
    const first = await topicPage(fetch(get('/api/topics?limit=2', as(LISTED))))
    expect(first.topics.map((topic) => topic.name)).toEqual(['Customer one', 'Customer 3'])
    const second = await topicPage(fetch(get(`/api/topics?limit=2&cursor=${first.next}`, as(LISTED))))
    expect(second).toEqual({ topics: [expect.objectContaining({ name: 'Customer 2' })] })
    expect((await fetch(get('/api/topics?limit=101', as(LISTED)))).status).toBe(400)
  })

  it('is refused past its requests for the minute, with how long to wait, and another grant is not (ADR 0085)', async () => {
    // The clock stands still, so the 602 requests never straddle the start of a new minute.
    const { fetch } = organizing({ frozen: true })
    const answers = await Promise.all(
      Array.from({ length: 601 }, () =>
        fetch(get('/api/personas?limit=1', as(APP))).then((response) => response.status),
      ),
    )
    expect(answers.filter((status) => status === 200)).toHaveLength(600)
    const refused = await fetch(get('/api/personas?limit=1', as(APP)))
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({
      // At the epoch, the next minute begins in a whole minute.
      error: { reason: 'rate_limited', retryAfter: 60 },
    })
    expect((await fetch(get('/api/personas?limit=1', as(credential({ id: 'key-9' }))))).status).toBe(200)
  })

  it('is refused once its grant ended, before anything runs', async () => {
    const { fetch } = organizing()
    const ended = credential({ id: 'key-e', expiresAt: 1 })
    const refused = await fetch(get('/api/topics', as(ended)))
    expect(refused.status).toBe(401)
    await refusedFor(refused, 'grant_expired')
  })

  it('reaches only endpoints that take credentials, and never grants resident authority', async () => {
    const { fetch, resident } = organizing()
    expect((await fetch(post('/api/topics', { name: 'A', operationId: 'svc:a' }, as(APP)))).status).toBe(201)
    expect(resident.grants).toHaveLength(0)
    // An endpoint no credential reaches: Undo in the organize log.
    const undo = await fetch(post('/api/organize/receipt-1/undo', {}, as(APP)))
    expect(undo.status).toBe(403)
    await refusedFor(undo, 'credential')
    await fetch(post('/api/topics', { name: 'B', operationId: 'owner-b' }))
    expect(resident.grants.length).toBeGreaterThan(0)
  })
})
