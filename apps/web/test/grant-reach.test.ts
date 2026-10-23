import { type GoblinReach, type GrantTerms, PRESET, presetFor } from '@goblin/contracts'
import { GRANT_SPEC } from '@goblin/contracts'
import { grantSummary } from '@goblin/ui'
import { describe, expect, it } from 'vitest'
import { GRANT_WORDS, grantProblem, reachWords } from '../src/components/grant-editor.tsx'
import {
  describeReach,
  entryOf,
  everything,
  reachedWorkspaces,
  withEntry,
  withWorkspaces,
} from '../src/lib/grant-reach.ts'

const ACME = { id: 'ws_acme', name: 'Acme', slug: 'acme', role: 'owner', members: 1 } as const
const BETA = { id: 'ws_beta', name: 'Beta', slug: 'beta', role: 'admin', members: 3 } as const
const PERSON = [ACME, BETA]
const ALL: GoblinReach = PRESET.reach

describe("a grant's reach in the editor", () => {
  it('reads a workspace without an entry as everything in it, and drops an entry back to everything over all', () => {
    expect(entryOf(ALL, ACME.id)).toEqual(everything(ACME.id))
    const narrowed = withEntry(ALL, { ...everything(ACME.id), topics: { kind: 'list', ids: ['12'] } })
    expect(narrowed.each).toEqual([{ ...everything(ACME.id), topics: { kind: 'list', ids: ['12'] } }])
    expect(withEntry(narrowed, everything(ACME.id)).each).toEqual([])
  })

  it('keeps a listed workspace’s entry whatever it holds, and narrows from all to exactly the chosen', () => {
    const one = withWorkspaces(ALL, [BETA.id])
    expect(one).toEqual({ workspaces: 'list', each: [everything(BETA.id)], origins: [] })
    expect(withEntry(one, everything(BETA.id)).each).toEqual([everything(BETA.id)])
    expect(reachedWorkspaces(one, PERSON)).toEqual([BETA.id])
    expect(reachedWorkspaces(ALL, PERSON)).toEqual([ACME.id, BETA.id])
  })

  it('carries what a workspace held across the switch to all and back', () => {
    const narrowed = withEntry(withWorkspaces(ALL, [ACME.id]), {
      ...everything(ACME.id),
      personas: { kind: 'list', ids: [] },
    })
    const widened = withWorkspaces(narrowed, 'all')
    expect(widened).toEqual({ workspaces: 'all', each: [narrowed.each[0]], origins: [] })
    expect(withWorkspaces(widened, [ACME.id, BETA.id]).each).toEqual([narrowed.each[0], everything(BETA.id)])
  })

  it('says the reach in words, for a client and for a key in its own workspace', () => {
    expect(describeReach(ALL, PERSON)).toBe('everything in all your workspaces')
    expect(describeReach(withWorkspaces(ALL, []), PERSON)).toBe('nothing')
    expect(describeReach(withWorkspaces(ALL, [ACME.id, BETA.id]), PERSON)).toBe('everything in Acme and Beta')
    const mixed = withEntry(withWorkspaces(ALL, [ACME.id, BETA.id]), {
      workspace: BETA.id,
      topics: { kind: 'list', ids: ['3', '4'] },
      personas: { kind: 'all' },
      connections: { kind: 'list', ids: ['notes'] },
    })
    expect(describeReach(mixed, PERSON)).toBe('everything in Acme; 2 Topics, all Personas and 1 connection in Beta')
    expect(describeReach(withEntry(ALL, mixed.each[1] ?? everything(BETA.id)), PERSON)).toBe(
      'everything in all your workspaces (2 Topics, all Personas and 1 connection in Beta)',
    )
    const key = presetFor('swarm', [ACME.id]).reach
    expect(describeReach(key, [ACME], ACME.id)).toBe('everything')
    const bringing = { ...key, origins: [{ origin: 'https://mcp.example.com', tools: ['job_submit'] }] }
    expect(describeReach(bringing, [ACME], ACME.id)).toBe('everything, and may bring 1 MCP server')
    expect(describeReach(withWorkspaces(ALL, ['ws_gone']), PERSON)).toBe('everything in a workspace you left')
  })
})

/** The line a client's summary shows for `terms`. */
const line = (terms: GrantTerms, name = 'Claude Code') =>
  grantSummary({
    clientName: name,
    terms,
    spec: GRANT_SPEC,
    words: GRANT_WORDS,
    describeReach: reachWords({ kind: 'client', workspaces: PERSON }),
  })

describe("a grant's summary line", () => {
  it('says who can do what where, the extras on and off, and how long', () => {
    expect(line(PRESET)).toBe(
      'Claude Code can write everything in all your workspaces · no setup, routines, inspect or keys · until revoked',
    )
    expect(line({ ...PRESET, level: 'manage', extras: ['inspect', 'setup'], lifetime: '30d' })).toBe(
      'Claude Code can manage everything in all your workspaces · with setup and inspect · no routines or keys · for 30 days',
    )
    expect(line({ ...PRESET, level: 'read', extras: ['setup', 'routines', 'inspect', 'keys'], lifetime: '365d' })).toBe(
      'Claude Code can read everything in all your workspaces · with setup, routines, inspect and keys · for 1 year',
    )
  })

  it('says a key’s reach without its workspace', () => {
    const terms = presetFor('swarm', [ACME.id])
    expect(
      grantSummary({
        clientName: 'It',
        terms,
        spec: GRANT_SPEC,
        words: GRANT_WORDS,
        describeReach: reachWords({ kind: 'key', workspace: ACME }),
      }),
    ).toBe('It can write everything · no setup, routines, inspect or keys · until revoked')
  })
})

describe('what stops a grant from being saved', () => {
  it('needs a workspace and well-formed servers, and says which is wrong', () => {
    expect(grantProblem(PRESET)).toBe('')
    expect(grantProblem({ ...PRESET, reach: withWorkspaces(ALL, []) })).toBe('Choose at least one workspace.')
    const origins = [{ origin: 'http://localhost', tools: ['a'] }]
    expect(grantProblem({ ...PRESET, reach: { ...ALL, origins } })).toMatch(/https address of a public host/u)
    const toolless = [{ origin: 'https://mcp.example.com', tools: [] }]
    expect(grantProblem({ ...PRESET, reach: { ...ALL, origins: toolless } })).toMatch(/1 to 50 tool names/u)
  })
})
