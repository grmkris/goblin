// Ported from grmkris/myapps packages/grants/test/terms.test.ts (b8014322), over goblin's own vocabulary and reach.
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  AccessSummary,
  ConsentTerms,
  GRANT_SPEC,
  type GoblinReach,
  GrantTerms,
  PRESET,
  ROLE_POWER,
  defaultTerms,
  expiresAt,
  levelAtLeast,
  missingFor,
  presetFor,
  reachId,
  reaches,
  reachesWorkspace,
  widenUrl,
} from './grants.ts'

const decode = Schema.decodeUnknownSync(GrantTerms)

/** A key's reach: its one workspace, Topics 7 and 9, every Persona, the `mycut` connection. */
const listed: GoblinReach = {
  workspaces: 'list',
  each: [
    {
      workspace: 'w1',
      topics: { kind: 'list', ids: ['7', '9'] },
      personas: { kind: 'all' },
      connections: { kind: 'list', ids: ['mycut'] },
    },
  ],
  origins: [],
}
const previous: GrantTerms = {
  name: 'saved',
  level: 'read',
  reach: listed,
  extras: ['setup', 'inspect', 'routines', 'keys'],
  lifetime: '7d',
}

describe('grant terms', () => {
  it("decodes goblin's vocabulary and rejects other levels, extras, lifetimes, reach and names", () => {
    expect(decode(previous)).toEqual(previous)
    expect(decode(PRESET)).toEqual(PRESET)
    const workspace = listed.each[0]
    for (const invalid of [
      { level: 'owner' },
      { level: 'edit' },
      { extras: ['spend'] },
      { extras: ['transcripts'] },
      { extras: ['inspect', 'inspect'] },
      { lifetime: '2d' },
      { name: '' },
      { reach: { ...listed, workspaces: 'some' } },
      { reach: { ...listed, each: [{ ...workspace, topics: { kind: 'own' } }] } },
      { reach: { ...listed, each: [{ ...workspace, topics: { kind: 'list', ids: [7] } }] } },
      { reach: { ...listed, each: [{ ...workspace, topics: { kind: 'list', ids: ['0'] } }] } },
      { reach: { ...listed, each: [{ ...workspace, connections: { kind: 'list', ids: ['a/b'] } }] } },
      { reach: { ...listed, each: [workspace, workspace] } },
    ])
      expect(() => decode({ ...previous, ...invalid }), JSON.stringify(invalid)).toThrow()
  })

  it('summarizes a grant with its id, its credential, its end and its widening link', () => {
    const summary = {
      ...PRESET,
      grantId: 'cg_1',
      clientId: 'client-1',
      expiresAt: null,
      widenUrl: 'https://goblin.test/consent/widen?grant=cg_1',
    }
    expect(Schema.decodeUnknownSync(AccessSummary)(summary)).toEqual(summary)
    for (const invalid of [{ expiresAt: 1 }, { level: 'owner' }, { widenUrl: undefined }, { grantId: undefined }])
      expect(() => Schema.decodeUnknownSync(AccessSummary)({ ...summary, ...invalid })).toThrow()
  })

  it('offers reach as a tree of workspaces, their groups and reach ids', () => {
    const terms = {
      spec: {
        levels: GRANT_SPEC.levels,
        extras: GRANT_SPEC.extras,
        reachOptions: [
          {
            id: 'w1',
            label: 'Mine',
            children: [
              {
                id: 'w1/topic',
                label: 'Topics',
                selectable: false,
                children: [
                  { id: reachId('w1', 'topic', '7'), label: 'Orders', usedBy: [{ grantId: 'k1', name: 'x' }] },
                ],
              },
            ],
          },
        ],
      },
      defaults: PRESET,
      current: null,
    }
    expect(Schema.decodeUnknownSync(ConsentTerms)(terms)).toEqual(terms)
  })
})

describe('the default chain', () => {
  it('prefers the same client and keeps its risky extras', () => {
    expect(defaultTerms(GRANT_SPEC, { sameClient: previous, latest: PRESET })).toBe(previous)
  })

  it('takes the risky extras off the latest grant without changing it', () => {
    expect(defaultTerms(GRANT_SPEC, { latest: previous })).toEqual({ ...previous, extras: ['inspect'] })
    expect(previous.extras).toEqual(['setup', 'inspect', 'routines', 'keys'])
    expect(defaultTerms({ ...GRANT_SPEC, extras: [] }, { latest: previous }).extras).toEqual([])
  })

  it("uses the spec's preset when there is no history, with the name and workspaces the caller gives", () => {
    expect(defaultTerms(GRANT_SPEC, {})).toBe(PRESET)
    const preset = presetFor('swarmm', ['w1'])
    expect(defaultTerms({ ...GRANT_SPEC, preset }, {})).toEqual({
      name: 'swarmm',
      level: 'write',
      reach: {
        workspaces: 'list',
        each: [{ workspace: 'w1', topics: { kind: 'all' }, personas: { kind: 'all' }, connections: { kind: 'all' } }],
        origins: [],
      },
      extras: [],
      lifetime: 'never',
    })
    expect(PRESET).toMatchObject({ level: 'write', reach: { workspaces: 'all', each: [] }, extras: [] })
  })
})

describe('expiry', () => {
  it.each([
    ['1d', 1],
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
    ['365d', 365],
  ] as const)('adds %s to the approval time', (lifetime, days) => {
    const now = 1_792_843_200_000
    expect(expiresAt(lifetime, now)).toBe(now + days * 86_400_000)
  })

  it('has no end until revoked', () => {
    expect(expiresAt('never', 0)).toBeNull()
    expect(GRANT_SPEC.defaultLifetime).toBe('never')
  })
})

describe('access checks', () => {
  it('orders levels and fails closed for levels outside the vocabulary', () => {
    expect(levelAtLeast(GRANT_SPEC, 'manage', 'write')).toBe(true)
    expect(levelAtLeast(GRANT_SPEC, 'write', 'write')).toBe(true)
    expect(levelAtLeast(GRANT_SPEC, 'write', 'manage')).toBe(false)
    expect(levelAtLeast(GRANT_SPEC, 'read', 'write')).toBe(false)
    expect(levelAtLeast(GRANT_SPEC, 'owner', 'read')).toBe(false)
    expect(levelAtLeast(GRANT_SPEC, 'manage', 'owner')).toBe(false)
  })

  it('reports every missing term and admits what the grant covers', () => {
    const terms = { ...previous, extras: [] }
    expect(
      missingFor(GRANT_SPEC, terms, { level: 'write', reachId: reachId('w1', 'topic', '8'), extra: 'inspect' }),
    ).toEqual({ level: 'write', reachId: 'w1/topic/8', extra: 'inspect' })
    expect(missingFor(GRANT_SPEC, terms, { level: 'read', reachId: 'w1/topic/7' })).toBeNull()
    expect(missingFor(GRANT_SPEC, terms, { reachId: 'w1/persona/45' })).toBeNull()
    expect(missingFor(GRANT_SPEC, terms, { reachId: 'w1/connection/mycut' })).toBeNull()
    expect(missingFor(GRANT_SPEC, terms, { reachId: 'w1/connection/github' })).toEqual({
      reachId: 'w1/connection/github',
    })
    expect(missingFor(GRANT_SPEC, { ...terms, extras: ['inspect'] }, { extra: 'inspect' })).toBeNull()
    expect(missingFor(GRANT_SPEC, terms, {})).toBeNull()
  })

  it('lacks every reach id when the terms carry no reach, as a forwarded credential does', () => {
    const forwarded = { level: 'manage', extras: ['setup'] } as const
    expect(missingFor(GRANT_SPEC, forwarded, { level: 'manage', extra: 'setup' })).toBeNull()
    expect(missingFor(GRANT_SPEC, forwarded, { reachId: 'w1' })).toEqual({ reachId: 'w1' })
  })

  it('fails closed for a reach id that does not parse', () => {
    for (const id of ['', '/topic/7', 'w1/topic', 'w1/topic/', 'w1/chat/7', 'w1/topic/7/more'])
      expect(missingFor(GRANT_SPEC, PRESET, { reachId: id }), id).toEqual({ reachId: id })
  })
})

describe('reach', () => {
  it('reaches all of a kind, or only what its list holds', () => {
    expect(reaches(listed, 'w1', 'topic', '7')).toBe(true)
    expect(reaches(listed, 'w1', 'topic', '8')).toBe(false)
    expect(reaches(listed, 'w1', 'persona', '45')).toBe(true)
    expect(reaches(listed, 'w1', 'connection', 'mycut')).toBe(true)
    expect(reaches(listed, 'w1', 'connection', 'github')).toBe(false)
    const empty: GoblinReach = {
      ...listed,
      each: [
        { workspace: 'w1', topics: { kind: 'list', ids: [] }, personas: { kind: 'all' }, connections: { kind: 'all' } },
      ],
    }
    expect(reaches(empty, 'w1', 'topic', '1')).toBe(false)
  })

  it("reaches only listed workspaces, or every one of the person's with everything in those it does not list", () => {
    expect(reachesWorkspace(listed, 'w1')).toBe(true)
    expect(reachesWorkspace(listed, 'w2')).toBe(false)
    expect(reaches(listed, 'w2', 'topic', '7')).toBe(false)
    const all: GoblinReach = { ...listed, workspaces: 'all' }
    expect(reachesWorkspace(all, 'w2')).toBe(true)
    expect(reaches(all, 'w2', 'topic', '8')).toBe(true)
    expect(reaches(all, 'w1', 'topic', '8')).toBe(false)
    expect(missingFor(GRANT_SPEC, { ...previous, reach: all }, { reachId: 'w2' })).toBeNull()
    expect(missingFor(GRANT_SPEC, previous, { reachId: 'w2' })).toEqual({ reachId: 'w2' })
  })
})

describe('roles', () => {
  it('gives an owner every extra, an admin all but keys, and a member write and inspect', () => {
    expect(ROLE_POWER).toEqual({
      owner: { level: 'manage', extras: ['setup', 'routines', 'inspect', 'keys'] },
      admin: { level: 'manage', extras: ['setup', 'routines', 'inspect'] },
      member: { level: 'write', extras: ['inspect'] },
    })
    expect(GRANT_SPEC.extras.filter((extra) => extra.risky).map((extra) => extra.id)).toEqual([
      'setup',
      'routines',
      'keys',
    ])
    expect(GRANT_SPEC.extras.filter((extra) => extra.ownerOnly === true).map((extra) => extra.id)).toEqual(['keys'])
  })
})

describe('widening', () => {
  it('round trips the grant and what is missing without query injection', () => {
    const missing = {
      level: 'manage',
      reachId: 'w1/topic/7&level=manage',
      extra: 'inspect',
      create: 'new+topic@example.test',
    } as const
    const url = new URL(widenUrl('https://goblin.test/', 'grant &/+#?', missing))
    expect(url.origin + url.pathname).toBe('https://goblin.test/consent/widen')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      grant: 'grant &/+#?',
      level: 'manage',
      reach: missing.reachId,
      extra: 'inspect',
      create: missing.create,
    })
    expect(new URL(widenUrl('https://goblin.test', 'g', {})).search).toBe('?grant=g')
  })

  it('asks to create something without naming an existing reach id', () => {
    const url = new URL(widenUrl('https://goblin.test', 'g', { create: 'Orders' }))
    expect(url.searchParams.get('create')).toBe('Orders')
    expect(url.searchParams.has('reach')).toBe(false)
  })
})
