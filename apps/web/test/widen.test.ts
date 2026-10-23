import { type ConsentTerms, GRANT_SPEC, type GrantTerms, PRESET, presetFor } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { everything, withWorkspaces } from '../src/lib/grant-reach.ts'
import { askedWords, parseWiden, reachItemOf, widened, wideningOf, withReachId } from '../src/lib/widen.ts'

const KEY: GrantTerms = presetFor('swarm', ['ws_acme'])
const LISTED: GrantTerms = {
  ...KEY,
  level: 'read',
  reach: {
    workspaces: 'list',
    each: [{ ...everything('ws_acme'), topics: { kind: 'list', ids: ['3'] } }],
    origins: [],
  },
}

describe("the widening link's terms", () => {
  it('keeps only what the grant contract knows', () => {
    expect(
      parseWiden({ grant: 'key_1', level: 'manage', reach: 'ws_acme/topic/12', extra: 'inspect', create: 'Launch' }),
    ).toEqual({ grant: 'key_1', level: 'manage', reach: 'ws_acme/topic/12', extra: 'inspect', create: 'Launch' })
    expect(parseWiden({ grant: '', level: 'admin', extra: 'spend', reach: 7 })).toEqual({})
  })

  it('takes a reach id apart, and a malformed one fails closed', () => {
    expect(reachItemOf('ws_acme/persona/4')).toEqual({ workspace: 'ws_acme', kind: 'persona', id: '4' })
    expect(reachItemOf('ws_acme')).toEqual({ workspace: 'ws_acme' })
    expect(reachItemOf('ws_acme/room/4')).toBeUndefined()
    expect(reachItemOf('ws_acme/topic/4/extra')).toBeUndefined()
    expect(reachItemOf('/topic/4')).toBeUndefined()
  })
})

describe('the terms a widening asks for', () => {
  it('adds the one item to its list, and leaves what is already reached as it is', () => {
    expect(withReachId(LISTED.reach, 'ws_acme/topic/12').each[0]?.topics).toEqual({ kind: 'list', ids: ['3', '12'] })
    expect(withReachId(LISTED.reach, 'ws_acme/topic/3')).toBe(LISTED.reach)
    expect(withReachId(LISTED.reach, 'ws_acme/persona/9')).toBe(LISTED.reach)
    expect(withReachId(PRESET.reach, 'ws_beta/topic/1')).toBe(PRESET.reach)
    expect(withReachId(LISTED.reach, 'nonsense/x')).toBe(LISTED.reach)
  })

  it('adds a workspace the grant lists without, with only the asked item in it', () => {
    const none = withWorkspaces(PRESET.reach, [])
    expect(withReachId(none, 'ws_beta/connection/notes').each).toEqual([
      {
        workspace: 'ws_beta',
        topics: { kind: 'list', ids: [] },
        personas: { kind: 'list', ids: [] },
        connections: { kind: 'list', ids: ['notes'] },
      },
    ])
    expect(withReachId(none, 'ws_beta').each).toEqual([
      {
        workspace: 'ws_beta',
        topics: { kind: 'list', ids: [] },
        personas: { kind: 'list', ids: [] },
        connections: { kind: 'list', ids: [] },
      },
    ])
  })

  it('raises the level and adds the extra, never lowering or taking anything away', () => {
    expect(widened(LISTED, { level: 'write', extra: 'inspect' })).toMatchObject({ level: 'write', extras: ['inspect'] })
    const managing = { ...LISTED, level: 'manage' as const, extras: ['setup' as const] }
    expect(widened(managing, { level: 'read', extra: 'setup' })).toEqual(managing)
    expect(widened(LISTED, {})).toEqual(LISTED)
  })

  it('compares only a live grant that is the one the link names', () => {
    const consent: ConsentTerms = {
      spec: { levels: GRANT_SPEC.levels, extras: GRANT_SPEC.extras, reachOptions: [] },
      defaults: KEY,
      current: LISTED,
      summary: { ...LISTED, grantId: 'key_1', keyId: 'key_1', expiresAt: null, widenUrl: 'https://app.test/x' },
      grantId: 'key_1',
    }
    const search = { grant: 'key_1', level: 'write', reach: 'ws_acme/topic/12' } as const
    expect(wideningOf(consent, search)).toMatchObject({
      grantId: 'key_1',
      current: LISTED,
      requested: { level: 'write', reach: { each: [{ topics: { kind: 'list', ids: ['3', '12'] } }] } },
    })
    expect(wideningOf(consent, { ...search, grant: 'key_2' })).toBeNull()
    expect(wideningOf({ ...consent, current: null }, search)).toBeNull()
    const { summary: _summary, ...withoutSummary } = consent
    expect(wideningOf(withoutSummary, search)).toBeNull()
  })

  it('says the reach it adds by its names, and what it wants to make', () => {
    const search = { grant: 'key_1', reach: 'ws_acme/topic/12', create: 'Launch' }
    const requested = widened(LISTED, search)
    expect(askedWords(search, LISTED, requested, { workspace: 'Acme', item: 'Launch plan' })).toEqual([
      'Topic “Launch plan” in Acme',
      'To make “Launch”',
    ])
    expect(askedWords({ reach: 'ws_acme/topic/3' }, LISTED, LISTED, { workspace: 'Acme' })).toEqual([])
    const none = { ...LISTED, reach: withWorkspaces(LISTED.reach, []) }
    expect(askedWords({ reach: 'ws_acme' }, none, widened(none, { reach: 'ws_acme' }), { workspace: 'Acme' })).toEqual([
      'The workspace Acme',
    ])
  })

  it('says by its id what it could not read the name of', () => {
    const search = { reach: 'ws_beta/persona/4' }
    const requested = widened(LISTED, search)
    expect(askedWords(search, LISTED, requested, {})).toEqual(['Persona 4 in ws_beta'])
  })
})
