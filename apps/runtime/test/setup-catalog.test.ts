import { type Allowed, EVERYTHING, NOTHING, type TopicSetup } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { AppEngine } from '../src/agent-apps/service.ts'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import { allows, refuseUnallowed, unallowed } from '../src/setup/catalog.ts'
import { Skills } from '../src/skills/service.ts'
import { stub } from './http/api/fixture.ts'
import { PERSONA_DENIED_TOOLS } from '../src/pi/persona-selection.ts'

const allowed: Allowed = {
  servers: [{ connectionId: 'notes', tools: [{ name: 'read' }] }],
  libraries: [{ connectionId: 'lib', skills: [{ name: 'review', uri: 'skill://v1/review/SKILL.md' }] }],
  apps: [{ name: 'tracker' }],
}

const outcome = (before: TopicSetup, next: TopicSetup) =>
  unallowed(before, next, allowed).length === 0 ? 'ok' : 'setup_not_allowed'

describe('what the agent may add to a setup (ADR 0040)', () => {
  it('allows what the owner granted or turned on now, and subagents', () => {
    expect(allows(allowed, { kind: 'tool', connectionId: 'notes', name: 'read' })).toBe(true)
    expect(allows(allowed, { kind: 'tool', connectionId: 'notes', name: 'write' })).toBe(false)
    expect(allows(allowed, { kind: 'skill', connectionId: 'lib', name: 'review' })).toBe(true)
    expect(allows(allowed, { kind: 'library', connectionId: 'other' })).toBe(false)
    expect(allows(allowed, { kind: 'app', app: 'tracker' })).toBe(true)
    expect(allows(allowed, { kind: 'subagents' })).toBe(true)
  })

  it('refuses a list naming something new the owner does not allow, and keeps what was already there', () => {
    const narrow: TopicSetup = { ...EVERYTHING, mcpServers: [{ connectionId: 'gone', tools: 'all' }], apps: [] }
    expect(outcome(narrow, narrow)).toBe('ok')
    expect(outcome(EVERYTHING, narrow)).toBe('ok')
    const added: TopicSetup = { ...narrow, apps: ['tracker', 'diary'] }
    expect(outcome(narrow, added)).toBe('setup_not_allowed')
    expect(outcome({ ...NOTHING, subagents: false }, { ...narrow, mcpServers: 'all' })).toBe('ok')
  })

  it('never lets the agent make a category hold everything, which only the owner gives (ADR 0108)', async () => {
    // The catalog is never read for it: these services answer nothing.
    const unread = Layer.mergeAll(
      stub(McpConnections),
      stub(McpServers),
      stub(McpGrants),
      stub(Skills),
      stub(AppEngine),
    )
    const reasonOf = (before: TopicSetup, next: TopicSetup) =>
      Effect.runPromise(
        refuseUnallowed(before, next).pipe(
          Effect.match({
            onFailure: (error) => ('reason' in error ? error.reason : error._tag),
            onSuccess: () => 'ok',
          }),
          Effect.provide(unread),
        ),
      )
    const none: TopicSetup = { ...NOTHING, subagents: false }
    expect(await reasonOf(none, { ...none, mcpServers: 'all' })).toBe('setup_all_owner_only')
    expect(await reasonOf(none, { ...none, skills: 'all' })).toBe('setup_all_owner_only')
    expect(await reasonOf(none, { ...none, apps: 'all' })).toBe('setup_all_owner_only')
    // What held everything before may keep it.
    expect(await reasonOf(EVERYTHING, EVERYTHING)).toBe('ok')
    expect(await reasonOf(EVERYTHING, { ...EVERYTHING, apps: [] })).toBe('ok')
  })

  it('is never in a Persona fork, which cannot organize', () => {
    expect(PERSONA_DENIED_TOOLS).toContain('topic_setup')
  })
})
